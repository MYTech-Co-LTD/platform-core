#!/usr/bin/env python3
# lab.py — 回填工具链的**本机 lab**：回环 S3 上的混代小湖 + mock 网关 + mock console。
#
# 为什么要有它：`scripts/lemeng/backfill-retail-order-line.sh` 的判据（Phase 0 守卫 / 批后列数 /
# 整湖混读）如果只在本机跑「假的字符串比较」，就证明不了它们在真湖形状上会动。本 lab 造一个
# **真 parquet、真 S3 协议、真 glob、真 hive 分区**的混代小湖（最老分区 18 列、其后若干 24 列），
# 让驱动脚本**原样**跑它自己的 SQL。**零生产**：全部读写都在 127.0.0.1 上的 s3rver 里。
#
# 三个子命令（编排在 scripts/lemeng/backfill-lab.sh）：
#   build-lake   造混代小湖（按真实湖的形状：3120 09-23..09-27 18 列、64188 09-25..09-27 18 列、
#                两账套 09-28 已是 24 列）
#   rewrite      把某 (账套, bizday) 的 24 个分区从 18 列重写成 24 列（模拟「新管线重采该窗」：
#                6 个新列的值**从 mock 网关取**，不是凭空造）
#   break        把某个分区写成「缺列」的旧形（复现 §4.0 不变量被破 ⇒ 整湖混读挂）
#   serve-gateway  mock 乐檬网关（whoami + 明细页）
#   serve-console  mock duckle console（`POST /api/run/async` → 触发 rewrite）
#
# ⚠️ mock console 是**按账套**起的（两个进程两个端口），与生产同形：一账套一 console，
#    凭据按账套绑定（见 deploy/data-compose.yml 与 console/README.md）。
import argparse
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen, Request

# ── 契约 v2 的 24 列（旧 18 + 新 6）；类型只在 lab 内有意义（判据只看**列数**与 order_no/bizday）──
OLD_COLS = [
    ('batch_id', 'VARCHAR'), ('system_book', 'VARCHAR'), ('bizday', 'DATE'), ('hour', 'INTEGER'),
    ('order_no', 'VARCHAR'), ('order_detail_num', 'VARCHAR'), ('branch_num', 'INTEGER'),
    ('branch_name', 'VARCHAR'), ('order_time', 'TIMESTAMP'), ('order_operate_time', 'TIMESTAMP'),
    ('state', 'VARCHAR'), ('order_source', 'VARCHAR'), ('item_num', 'VARCHAR'), ('item_code', 'VARCHAR'),
    ('sale_money', 'DECIMAL(14,2)'), ('discount_money', 'DECIMAL(14,2)'), ('payment_money', 'DECIMAL(14,2)'),
    ('quantity', 'INTEGER'),
]
NEW_COLS = [
    ('order_transaction_type', 'VARCHAR'), ('order_ref_billno', 'VARCHAR'),
    ('order_detail_share_discount', 'DECIMAL(14,2)'), ('order_detail_std_price', 'DECIMAL(14,2)'),
    ('order_detail_price', 'DECIMAL(14,2)'), ('order_detail_online_qty', 'INTEGER'),
]
HOURS = ['%02d' % h for h in range(24)]

# 真实湖的形状（spec §1.2 E1/E2 的订正版）：旧形 = 18 列，新形 = 24 列。
OLD_FORM_PARTITIONS = [
    ('3120', '2026-09-23'), ('3120', '2026-09-24'), ('3120', '2026-09-25'),
    ('3120', '2026-09-26'), ('3120', '2026-09-27'),
    ('64188', '2026-09-25'), ('64188', '2026-09-26'), ('64188', '2026-09-27'),
]
NEW_FORM_PARTITIONS = [('3120', '2026-09-28'), ('64188', '2026-09-28')]


def duckdb_run(args, sql):
    """把 SQL 交给 duckdb CLI（值只在进程内；lab 凭据是一次性的）。"""
    proc = subprocess.run([args.duckdb_bin], input=sql.encode('utf-8'),
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out = proc.stdout.decode('utf-8', 'replace')
    if proc.returncode != 0:
        raise SystemExit('duckdb 失败（rc=%d）：\n%s\n---- SQL ----\n%s' % (proc.returncode, out, sql))
    return out


def secret_sql(args):
    return ("CREATE SECRET lab_lake (TYPE S3, KEY_ID '%s', SECRET '%s', ENDPOINT '%s', "
            "URL_STYLE 'path', USE_SSL false, REGION 'us-east-1');\n"
            % (args.key_id, args.secret, args.s3_endpoint))


def part_path(args, book, day, hour):
    return '%s/system_book=%s/bizday=%s/hour=%s/all.parquet' % (args.lake_root, book, day, hour)


def lit(value, typ):
    return "CAST('%s' AS %s)" % (str(value).replace("'", "''"), typ)


def row_select(book, day, hour, batch_id):
    """一行数据的 SELECT（列序 = 契约列序）。"""
    vals = {
        'batch_id': batch_id, 'system_book': book, 'bizday': day, 'hour': int(hour),
        'order_no': 'O-%s-%s-%s' % (book, day.replace('-', ''), hour),
        'order_detail_num': '1', 'branch_num': 1001, 'branch_name': 'LAB门店',
        'order_time': '%s %s:00:00' % (day, hour), 'order_operate_time': '%s %s:01:00' % (day, hour),
        'state': 'normal', 'order_source': 'pos', 'item_num': 'I0001', 'item_code': 'C0001',
        'sale_money': '9.90', 'discount_money': '0.00', 'payment_money': '9.90', 'quantity': 1,
    }
    cols = ', '.join('%s AS %s' % (lit(vals[name], typ), name) for name, typ in OLD_COLS)
    return 'SELECT ' + cols


def cmd_build_lake(args):
    stmts = [secret_sql(args)]
    for book, day in OLD_FORM_PARTITIONS:
        for h in HOURS:
            stmts.append("COPY (%s) TO '%s' (FORMAT parquet);"
                         % (row_select(book, day, h, 'retail-%s-20260930T000000Z-%s' % (book, h)),
                            part_path(args, book, day, h)))
    for book, day in NEW_FORM_PARTITIONS:
        for h in HOURS:
            base = row_select(book, day, h, 'retail-%s-20260930T000000Z-%s' % (book, h))
            extra = ', '.join('%s AS %s' % (lit('SALE_ORDER' if name == 'order_transaction_type' else 0, typ), name)
                              for name, typ in NEW_COLS)
            stmts.append("COPY (SELECT *, %s FROM (%s) t) TO '%s' (FORMAT parquet);"
                         % (extra, base, part_path(args, book, day, h)))
    duckdb_run(args, '\n'.join(stmts) + '\n')
    print('build-lake: %d 个旧形日账套 + %d 个新形日账套（各 24 个分区）'
          % (len(OLD_FORM_PARTITIONS), len(NEW_FORM_PARTITIONS)))


def cmd_rewrite(args):
    """把一个 (账套, bizday) 的 24 个分区 18 列 → 24 列（模拟新管线重采该窗）。"""
    stmts = [secret_sql(args)]
    for h in (args.hours.split(',') if args.hours else HOURS):
        p = part_path(args, args.book, args.day, h)
        # 先物化再覆盖写（读写的同一个对象 ⇒ 必须先把旧形读进 temp 表）
        stmts.append("CREATE OR REPLACE TEMP TABLE _w AS SELECT * FROM read_parquet('%s');" % p)
        stmts.append("COPY (SELECT *, CAST('SALE_ORDER' AS VARCHAR) AS order_transaction_type, "
                     "CAST('REF-%s' AS VARCHAR) AS order_ref_billno, "
                     "CAST('0.00' AS DECIMAL(14,2)) AS order_detail_share_discount, "
                     "CAST('9.90' AS DECIMAL(14,2)) AS order_detail_std_price, "
                     "CAST('9.90' AS DECIMAL(14,2)) AS order_detail_price, "
                     "CAST(1 AS INTEGER) AS order_detail_online_qty FROM _w) "
                     "TO '%s' (FORMAT parquet);" % (h, p))
    duckdb_run(args, '\n'.join(stmts) + '\n')


def cmd_break(args):
    """把某个分区写成**缺列**的旧形 ⇒ 复现 spec §4.0 不变量被破（B-3：整湖混读挂）。"""
    p = part_path(args, args.book, args.day, args.hour)
    sql = secret_sql(args) + "COPY (%s) TO '%s' (FORMAT parquet);\n" % (
        row_select(args.book, args.day, args.hour, 'broken'), p)
    duckdb_run(args, sql)


# ── mock 服务 ─────────────────────────────────────────────────────────────────
GATEWAY_CALLS = {'whoami': 0, 'orders': 0, 'order_rows': 0}
CONSOLE_CALLS = {'runs': 0, 'runs_seen': []}


class Handler(BaseHTTPRequestHandler):
    server_version = 'backfill-lab/1.0'

    def log_message(self, fmt, *a):   # 默认打 stderr 会淹掉编排脚本的读数 ⇒ 静音
        pass

    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n) if n else b''
        try:
            return json.loads(raw or b'{}')
        except ValueError:
            return None

    def do_GET(self):
        if self.path.startswith('/stats'):
            if self.server.mode == 'gateway':
                return self._send(200, GATEWAY_CALLS)
            return self._send(200, CONSOLE_CALLS)
        if self.path.startswith('/healthz'):
            return self._send(200, {'ok': True})
        return self._send(404, {'error': 'not found'})

    def do_POST(self):
        if self.server.mode == 'gateway':
            return self._gateway()
        return self._console()

    # ── mock 乐檬网关 ──
    def _gateway(self):
        body = self._read_json()
        if body is None:
            return self._send(400, {'error': 'bad json'})
        method = (body.get('params') or {}).get('name')
        if self.path.startswith('/gateway/whoami') or method == 'whoami':
            GATEWAY_CALLS['whoami'] += 1
            book = self.server.book
            text = json.dumps({'company_id': book, 'branch_nums': [1001, 1002]})
            return self._send(200, {'jsonrpc': '2.0', 'id': 1,
                                    'result': {'content': [{'type': 'text', 'text': text}]}})
        if self.path.startswith('/gateway/orders'):
            GATEWAY_CALLS['orders'] += 1
            book = self.server.book
            day = (body.get('bizday') or '')
            rows = [{'order_transaction_type': 'SALE_ORDER', 'order_ref_billno': 'REF-%s' % day,
                     'order_detail_share_discount': 0.0, 'order_detail_std_price': 9.9,
                     'order_detail_price': 9.9, 'order_detail_online_qty': 1}]
            GATEWAY_CALLS['order_rows'] += len(rows)
            return self._send(200, {'company_id': book, 'bizday': day, 'rows': rows})
        return self._send(404, {'error': 'not found'})

    # ── mock duckle console（`/api/run/async`）──
    def _console(self):
        if not self.path.startswith('/api/run/async'):
            return self._send(404, {'error': 'not found'})
        body = self._read_json()
        if body is None:
            return self._send(400, {'error': 'bad json'})
        f = body.get('file') or ''
        if not f.endswith('lemeng.retail.windows.backfill.json'):
            # 与引擎同形：未知 file ⇒ 不跑
            return self._send(404, {'error': 'unknown pipeline file: %s' % f})
        bizday = ((body.get('params') or {}).get('BIZDAY') or '')
        if len(bizday) != 10:
            return self._send(400, {'error': 'missing/invalid param BIZDAY'})
        CONSOLE_CALLS['runs'] += 1
        CONSOLE_CALLS['runs_seen'].append({'book': self.server.book, 'bizday': bizday})
        # 「新管线重采该窗」：6 个新列的值从 mock 网关取，再覆盖写该日 24 个分区
        try:
            with urlopen(Request(self.server.gateway_url + '/gateway/orders',
                                 data=json.dumps({'bizday': bizday, 'book': self.server.book}).encode(),
                                 headers={'Content-Type': 'application/json'}), timeout=20) as r:
                got = json.loads(r.read().decode())
        except Exception as exc:   # noqa: BLE001 —— mock 里任何异常都要变成可见的 500
            return self._send(500, {'error': 'gateway fetch failed: %s' % exc})
        if not got.get('rows'):
            return self._send(500, {'error': 'gateway returned no rows'})
        try:
            cmd_rewrite(self.server.duck_args(bizday))
        except SystemExit as exc:
            return self._send(500, {'error': 'rewrite failed: %s' % exc})
        return self._send(202, {'runId': 'lab-%s-%s' % (self.server.book, bizday), 'status': 'accepted'})


def cmd_serve_gateway(args):
    srv = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    srv.mode = 'gateway'
    srv.book = args.book
    print('mock gateway on 127.0.0.1:%d (book=%s)' % (args.port, args.book), flush=True)
    srv.serve_forever()


def cmd_serve_console(args):
    srv = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    srv.mode = 'console'
    srv.book = args.book
    srv.gateway_url = args.gateway_url

    def duck_args(bizday):
        ns = argparse.Namespace(**vars(args))
        ns.day = bizday
        ns.hours = None
        return ns

    srv.duck_args = duck_args
    print('mock console on 127.0.0.1:%d (book=%s -> gateway %s)' % (args.port, args.book, args.gateway_url), flush=True)
    srv.serve_forever()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--duckdb-bin', default=os.environ.get('DUCKDB_BIN', 'duckdb'))
    ap.add_argument('--lake-root', default=os.environ.get('LAKE_ROOT', ''))
    ap.add_argument('--s3-endpoint', default=os.environ.get('LAB_S3_ENDPOINT', ''))
    ap.add_argument('--key-id', default=os.environ.get('LAB_S3_KEY_ID', 'S3RVER'))
    ap.add_argument('--secret', default=os.environ.get('LAB_S3_SECRET', 'S3RVER'))
    sub = ap.add_subparsers(dest='cmd', required=True)
    for name in ('build-lake', 'rewrite', 'break'):
        sp = sub.add_parser(name)
        if name in ('rewrite', 'break'):
            sp.add_argument('--book', required=True)
            sp.add_argument('--day', required=True)
        if name == 'rewrite':
            sp.add_argument('--hours', default=None)
        if name == 'break':
            sp.add_argument('--hour', required=True)
    for name in ('serve-gateway', 'serve-console'):
        sp = sub.add_parser(name)
        sp.add_argument('--port', type=int, required=True)
        sp.add_argument('--book', default='3120')
        if name == 'serve-console':
            sp.add_argument('--gateway-url', required=True)
    args = ap.parse_args()
    if not args.lake_root or not args.s3_endpoint:
        raise SystemExit('--lake-root 与 --s3-endpoint 必给')
    {'build-lake': cmd_build_lake, 'rewrite': cmd_rewrite, 'break': cmd_break,
     'serve-gateway': cmd_serve_gateway, 'serve-console': cmd_serve_console}[args.cmd](args)


if __name__ == '__main__':
    main()
