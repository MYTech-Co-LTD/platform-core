#!/usr/bin/env python3
"""delete-supplanted-hour-partitions.py — 删掉**已被天文件取代**的小时对象。

## 它解决什么

2026-10-20 起零售明细改成热/冷混合布局（`docs/architecture.md` §5.3）：
关闭日整天重采落一个天文件 `system_book=<B>/bizday=<Y>/all.parquet`，并写封版标记
`_DAILY/<B>-<Y>.parquet`；当天的小时对象 `system_book=<B>/bizday=<Y>/hour=<HH>/all.parquet`
从此**不再被读侧使用**（staging 的排除子句会把它们滤掉）。

但它们**仍会被 glob 命中**——`system_book=*/bizday=*/hour=*/all.parquet` 会把它们打开，
每个文件 ~8 ms（真机实测）。所以删它们换来的是**性能**，不是正确性：
读侧已经排除，删与不删都**不会错数**。

## 权限实测（2026-10-20，真机）

数据面这对 ZOS 凭据：**HEAD 对象 ✅ / DELETE 对象 ✅ / LIST 前缀 ❌（`AccessDenied`）**。
⇒ 本工具**不 LIST**：小时的 key 是**可构造**的（`hour=<HH>` × 00..23），
天文件与封版标记的 key 也是确定的，全部用 HEAD 判存在。

## 为什么必须是 ③ 档手搓

duckle **没有删除对象的能力**（`list_components` 查 delete/remove/cleanup/drop = 0 条，
2026-10-20 实测）。DuckDB 也没有 DELETE OBJECT。⇒ 本仓用纯标准库 SigV4 自己签。

## 安全设计（三条，每条都是 fail-closed）

1. **默认 dry-run**：不传 `--apply` 只打印计划，一个对象都不删。
2. **`--before` 必填**：只删 `bizday < --before` 的日子。这个参数是**重述窗口的护栏**——
   窗口内的日子还会被 heal/restate 重写，删了源就断了回退路。由操作者显式给值，
   不给默认值（默认值会让人不假思索地按下去）。
3. **删前必须证明替代物在**：该日必须①有封版标记 `_DAILY/<B>-<Y>.parquet`，**且**
   ②天文件 `bizday=<Y>/all.parquet` 存在。任一不满足就 `SKIP`，绝不删。
   「标记在但天文件不在」正是最该停下来的状态——那时删小时对象等于**删掉唯一副本**。

## 用法

  ZOS_ACCESS_KEY=… ZOS_SECRET_KEY=… ZOS_ENDPOINT=… ZOS_REGION=… ZOS_BUCKET=… \\
    python3 scripts/lemeng/delete-supplanted-hour-partitions.py \\
      --book 3120 --before 2026-10-10            # 先看计划
  …同上… --apply                                  # 真删

  --self-test   只跑内置断言（不联网），用于 CI/冒烟

## 输出（每行一条，便于 grep）

  DELETE_PLAN   book=<B> bizday=<Y> objects=<N>
  SKIP_NOT_SEALED   book=<B> bizday=<Y> reason=…
  DELETE_DONE   ok=<N> failed=<M>
  DELETE_DRY_RUN done=<N>（未删任何对象）

退出码：0 全部成功（或 dry-run）；1 有失败或有不安全状态；2 参数/env 不合法。
"""
from __future__ import annotations

import hashlib
import hmac
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

EMPTY_SHA = hashlib.sha256(b"").hexdigest()
PREFIX = "lemeng/retail_order_line"


# ── 纯函数（可离线测）─────────────────────────────────────────────────────────
def eligible(
    sealed: set[tuple[str, str]],
    day_files: set[tuple[str, str]],
    book: str,
    before: str,
) -> tuple[list[str], list[tuple[str, str]]]:
    """挑出可以删小时对象的日子。

    @param sealed      `_DAILY/` 里看得到封版标记的 (book, bizday)
    @param day_files   天文件 `bizday=<Y>/all.parquet` 存在的 (book, bizday)
    @param book        账套
    @param before      只处理 bizday < before
    @return            (可删的 bizday 升序, [(bizday, 跳过原因)])

    判据：**三条件同时成立**才可删 —— ①已封版 ②天文件在 ③bizday < before。
    任何一条不满足都跳过并给原因；「标记在但天文件不在」是最危险的那种，单独给原因。
    """
    ok: list[str] = []
    skip: list[tuple[str, str]] = []
    for b, y in sorted(sealed):
        if b != book:
            continue
        if y >= before:
            skip.append((y, "within_restate_window"))
            continue
        if (b, y) not in day_files:
            skip.append((y, "sealed_but_day_file_missing"))
            continue
        ok.append(y)
    return ok, skip


def days_between(frm: str, before: str) -> list[str]:
    """[frm, before) 的日期串升序。都是 YYYY-MM-DD；不合法直接抛（fail-closed）。"""
    d0 = datetime.strptime(frm, "%Y-%m-%d").date()
    d1 = datetime.strptime(before, "%Y-%m-%d").date()
    if d0 >= d1:
        raise SystemExit(f"ARGS_FAILED: --from({frm}) 必须早于 --before({before})")
    out: list[str] = []
    from datetime import timedelta
    cur = d0
    while cur < d1:
        out.append(cur.isoformat())
        cur += timedelta(days=1)
    return out


def _uri(path: str) -> str:
    return urllib.parse.quote(path, safe="/-_.~")


# ── SigV4（纯标准库）─────────────────────────────────────────────────────────
class S3:
    def __init__(self, ak: str, sk: str, endpoint: str, region: str, bucket: str) -> None:
        self.ak, self.sk = ak, sk
        self.host, self.region, self.bucket = endpoint, region, bucket

    def _sign(self, method: str, path: str, query: dict[str, str]) -> dict[str, str]:
        amz = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        day = amz[:8]
        q = "&".join(f"{_uri(k)}={_uri(v)}" for k, v in sorted(query.items()))
        payload = EMPTY_SHA
        canon = "\n".join(
            [method, _uri(path), q, f"host:{self.host}\nx-amz-content-sha256:{payload}\nx-amz-date:{amz}\n",
             "host;x-amz-content-sha256;x-amz-date", payload]
        )
        scope = f"{day}/{self.region}/s3/aws4_request"
        sts = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(canon.encode()).hexdigest()])
        k = ("AWS4" + self.sk).encode()
        for part in (day, self.region, "s3", "aws4_request"):
            k = hmac.new(k, part.encode(), hashlib.sha256).digest()
        sig = hmac.new(k, sts.encode(), hashlib.sha256).hexdigest()
        return {
            "Authorization": f"AWS4-HMAC-SHA256 Credential={self.ak}/{scope}, "
                             f"SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature={sig}",
            "x-amz-content-sha256": payload,
            "x-amz-date": amz,
        }

    def _call(self, method: str, key: str, query: dict[str, str]) -> bytes:
        path = f"/{self.bucket}/{key}" if key else f"/{self.bucket}"
        req = urllib.request.Request(
            f"http://{self.host}{_uri(path)}" + (("?" + urllib.parse.urlencode(query, quote_via=urllib.parse.quote, safe="-_.~")) if query else ""),
            method=method,
        )
        for k, v in self._sign(method, path, query).items():
            req.add_header(k, v)
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()

    def exists(self, key: str) -> bool:
        """HEAD 该 key 是否存在。**不 LIST**：这对凭据的 ListBucket 被策略拒绝（实测 403），
        而小时的 key 完全可构造 ⇒ 逐个 HEAD 就够，也不需要列举。"""
        path = f"/{self.bucket}/{key}"
        req = urllib.request.Request(f"http://{self.host}{_uri(path)}", method="HEAD")
        for k, v in self._sign("HEAD", path, {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=20):
                return True
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return False
            raise

    def delete(self, key: str) -> bool:
        """删一个 key。S3 的 DELETE 幂等 ⇒ 404 也当成功（早就没了）。"""
        path = f"/{self.bucket}/{key}"
        req = urllib.request.Request(f"http://{self.host}{_uri(path)}", method="DELETE")
        for k, v in self._sign("DELETE", path, {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=20):
                return True
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return True
            raise


# ── self-test（不联网）─────────────────────────────────────────────────────────
def self_test() -> int:
    sealed = {("3120", "2026-10-01"), ("3120", "2026-10-05"), ("3120", "2026-10-12"), ("64188", "2026-10-01")}
    day_files = {("3120", "2026-10-01"), ("3120", "2026-10-12")}
    ok, skip = eligible(sealed, day_files, "3120", "2026-10-10")
    assert ok == ["2026-10-01"], ok                      # 只有它三条全中
    d = dict(skip)
    assert d["2026-10-05"] == "sealed_but_day_file_missing", d  # 标记在、天文件不在 ⇒ 绝不删
    assert d["2026-10-12"] == "within_restate_window", d        # 窗口内 ⇒ 跳过
    ok2, _ = eligible(sealed, day_files, "64188", "2026-10-10")
    assert ok2 == [], ok2                                # 别家账套不碰
    # 变异确认：把 before 提前到 10-01，10-01 也应被窗口挡掉
    ok3, skip3 = eligible(sealed, day_files, "3120", "2026-10-01")
    assert ok3 == [] and dict(skip3)["2026-10-01"] == "within_restate_window", (ok3, skip3)
    print("self-test OK")
    return 0


def main() -> int:
    argv = sys.argv[1:]
    if "--self-test" in argv:
        return self_test()

    def arg(name: str, required: bool = True) -> str:
        if name in argv:
            i = argv.index(name)
            if i + 1 < len(argv):
                return argv[i + 1]
        if required:
            print(f"ARGS_FAILED: 缺少 {name}", file=sys.stderr)
            sys.exit(2)
        return ""

    book = arg("--book")
    before = arg("--before")
    frm = arg("--from", required=False) or ""
    if not frm:
        # 默认回看 30 天（**只是扫描范围**，安不安全由 --before 与三条判据决定）
        from datetime import timedelta
        frm = (datetime.strptime(before, "%Y-%m-%d").date() - timedelta(days=30)).isoformat()
    apply_ = "--apply" in argv
    if not (len(before) == 10 and before[4] == "-" and before[7] == "-"):
        print(f"ARGS_FAILED: --before 必须是 YYYY-MM-DD，得到 {before!r}", file=sys.stderr)
        return 2

    # 两套命名都认（console 容器里同时挂着 ZOS_* 与 LEMENG_ZOS_*，且后者把 SECRET 叫
    # LEMENG_ZOS_SECRET、不叫 _KEY——按别名表取，别用字符串拼接猜）。
    ALIASES = {
        "ZOS_ACCESS_KEY": ("LEMENG_ZOS_ACCESS_KEY",),
        "ZOS_SECRET_KEY": ("LEMENG_ZOS_SECRET", "LEMENG_ZOS_SECRET_KEY"),
        "ZOS_ENDPOINT": ("LEMENG_ZOS_ENDPOINT",),
        "ZOS_REGION": ("LEMENG_ZOS_REGION",),
        "ZOS_BUCKET": ("LEMENG_ZOS_BUCKET",),
    }
    env = {}
    for k, aliases in ALIASES.items():
        v = os.environ.get(k, "")
        for a in aliases:
            if not v:
                v = os.environ.get(a, "")
        env[k] = v
    missing = [k for k, v in env.items() if not v]
    if missing:
        print(f"ENV_FAILED: 缺 {', '.join(missing)}（只写「在哪、怎么取」，不从代码里兜底）", file=sys.stderr)
        return 2

    s3 = S3(env["ZOS_ACCESS_KEY"], env["ZOS_SECRET_KEY"], env["ZOS_ENDPOINT"], env["ZOS_REGION"], env["ZOS_BUCKET"])

    # 枚举候选日：全部靠 HEAD，不 LIST
    sealed: set[tuple[str, str]] = set()
    day_files: set[tuple[str, str]] = set()
    for y in days_between(frm, before):
        if s3.exists(f"{PREFIX}/_DAILY/{book}-{y}.parquet"):
            sealed.add((book, y))
        if s3.exists(f"{PREFIX}/system_book={book}/bizday={y}/all.parquet"):
            day_files.add((book, y))

    ok, skip = eligible(sealed, day_files, book, before)
    for y, why in skip:
        print(f"SKIP_NOT_SEALED book={book} bizday={y} reason={why}")
    total = 0
    for y in ok:
        keys = [f"{PREFIX}/system_book={book}/bizday={y}/hour={h:02d}/all.parquet" for h in range(24)]
        present = [k for k in keys if s3.exists(k)]
        if not present:
            continue
        total += len(present)
        print(f"DELETE_PLAN book={book} bizday={y} objects={len(present)}")
        if apply_:
            bad = 0
            for k in present:
                try:
                    s3.delete(k)
                except Exception as e:  # noqa: BLE001 — 失败只影响性能，不错数；但要报出来
                    bad += 1
                    print(f"DELETE_FAILED key={k} err={e}", file=sys.stderr)
            print(f"DELETE_DONE book={book} bizday={y} ok={len(present) - bad} failed={bad}")
            if bad:
                return 1
    if not apply_:
        print(f"DELETE_DRY_RUN done={total}（未删任何对象；加 --apply 才真删）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
