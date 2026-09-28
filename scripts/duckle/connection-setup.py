#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""connection-setup.py —— 加密连接（duckle `connectionRef`）的一次性 setup。

把**容器 env 里已有的凭据**加密写成 duckle 的连接文件。跑一次，之后管线 JSON 里只写
`connectionRef`，一个密钥字符都不落。

================================================================================
怎么跑（容器内，一条命令）
================================================================================
    # 湖（S3 兼容：天翼云 ZOS）。读 ZOS_ENDPOINT/ZOS_ACCESS_KEY/ZOS_SECRET_KEY/
    # ZOS_BUCKET/ZOS_REGION —— 这些键名已是全仓既有口径（compose / dbt profiles 同源）。
    python3 /opt/connection-setup.py --workspace /workspace --id zos --profile zos-s3

    # 业务网关（REST bearer）。token 的键名由 --token-env 显式给，脚本不替你猜。
    python3 /opt/connection-setup.py --workspace /workspace --id lemeng \\
        --profile rest-bearer --token-env LEMENG_TOKEN

    # 先干跑核对（不落盘、不建钥匙）
    ... --dry-run

    # 事后只读复查（可给文件或目录）——与写完自检同一函数
    python3 /opt/connection-setup.py --check-only /workspace/connections

    # 完全自定义（profile 覆盖不到时）
    ... --profile none --set kind=literal:s3 --set bucket=env:MY_BUCKET \\
        --set secretKey=env:MY_SECRET

**跑完自检**：每次都回读落盘文件，只要还剩明文敏感字段就**非零退出**（不许静默产出明文）。

================================================================================
红线（改这个脚本前先读）
================================================================================
1. **绝不回显凭据值**。所有路径只打印键名 / 来源 / 长度 / sha256[:12] 指纹。
   指纹是**有意**的：它是与引擎侧回显对账的锚（lab 口径 `fcd77c2f93ca`）。
   ⚠️ 指纹是弱前缀，不要把它当口令贴到公开处。
2. **绝不覆盖已有钥匙**。`<ws>/.duckle/keys/secret.key` 存在即复用；覆盖它会**孤立**
   该工作区所有既有密文（引擎侧表现为静默空凭据 ⇒ 静默 401）。既存钥匙不是 32 字节 ⇒ 拒跑。
3. **绝不接受 `literal:` 传敏感值**（`ps` / shell history 可见）。敏感字段只能 `env:` / `file:`。
4. **自己实现的 AES-256-GCM 是纯 stdlib 的**（见 §为什么不用 cryptography）。它与
   `crates/duckle-secrets/src/lib.rs` 逐条对齐，并被三层独立验证：L1 独立实现互解
   （node:crypto，CI）、L2 真引擎解密（duckle 0.7.4，报告 §3）、L3 AAD 换名解不开。
   **动密码学那一段就重跑那三层**。

================================================================================
连接 id 约定（重要，与正典的资产归属原则一致）
================================================================================
**id 一律「账套无关」**（`zos` / `lemeng` / `pgduck` …），**不要**写成 `lemeng.zos` /
`shanhai-zos` 之类带账套前缀的名字。理由：

  · 连接文件是**按各 workspace 自己的钥匙**加密的 —— 每个 console 工作区各存一份自己的
    `connections/<id>.json` + 自己的 `.duckle/keys/secret.key`，**密文不互通也不是问题**
    （那正是 AAD 绑定 + 各 workspace 一把钥匙的用意）。
  · 所以「账套」这个维度已经由**工作区**承载了，再往 id 里编一份就是**两个事实源**：
    管线 JSON 里的 `connectionRef` 会被迫带账套名 ⇒ 同一份管线子在两个账套上不能共用，
    而正典（`docs/data-platform-handbook.md` §1.1.7）要求管线定义与账套解耦。
  · 推论：**同一个 id 在不同账套下是不同的凭据**（这正是要的）。轮换凭据时只动**那一个
    workspace** 的 env 与连接文件，互不牵连。

================================================================================
为什么不用 cryptography（容器实测，2026-09-28）
================================================================================
目标容器 `platform-core-duckle:local`（python:3.12-slim 基座）只读探测结果：
  · `import cryptography` / `Crypto` / `nacl` —— **全无**；site-packages 只有 duckdb-cli / duckle / pip
  · `node` / `nodejs` / `npm` —— **全无**（所以不可能是 node 脚本）
  · `openssl` 3.5.7 **在**，但 `openssl enc -aes-256-gcm` 直接拒绝：`enc: AEAD ciphers not
    supported`；且 `enc` 也没有 AAD 入口 ⇒ 命令行 openssl 这条路**不通**
  · 有 python3 3.12 + pip3，但装 `cryptography` 要改 `deploy/duckle/Dockerfile` ⇒ **重建镜像**；
    而这是在**已经在跑调度**的 console 容器上做一次性 setup，能不动镜像就不动

⇒ 选**纯 stdlib**：零依赖、零网络、零镜像重建，脚本 `docker cp` 进去就能跑。
代价是密码学那一段要自己实现 —— 见 §红线 4 的三层验证，以及报告里的取舍记。

退出码：0 成功；2 用法错；3 明文护栏未过；4 必填来源缺失；5 钥匙有问题。
"""

import argparse
import base64
import hashlib
import json
import os
import sys

PROG = "connection-setup.py"
ENC_PREFIX_V1 = "enc:v1:"
ENC_PREFIX_V2 = "enc:v2:"

# crates/duckle-secrets/src/lib.rs:30 SENSITIVE_KEYS —— **逐字照抄，不要凭记忆增删**
SENSITIVE_KEYS = [
    "password",
    "secretKey",
    "accessKey",
    "accountKey",
    "sessionToken",
    "pat",
    "token",
    "apiKey",
    "passphrase",
    "secret",
    "clientSecret",
    "accessToken",
    "authToken",
]
_SENSITIVE = frozenset(SENSITIVE_KEYS)

HERE = os.path.dirname(os.path.abspath(__file__))
# 供测试/CI 覆写（默认指向本脚本同目录的 kat.json）
KAT_PATH = os.environ.get("DUCKLE_CONN_KAT") or os.path.join(HERE, "connection-setup.kat.json")


class Usage(Exception):
    """用法 / 前置条件不满足（退出码 2）。"""


class KeyProblem(Exception):
    """钥匙相关（退出码 5）：既有钥匙损坏、或既有密文解不开。"""


def _sealable(v):
    """该不该封 —— 与 lib.rs:245 的 transform() 判据**逐条对齐**：
    是字符串、非空、不是 enc: 开头、不是 ${...} 占位符。"""
    return (isinstance(v, str) and v != "" and not is_encrypted(v) and not v.startswith("${"))


# ═══════════════════════════════════════════════════════════════════════════════
# AES-256-GCM（纯 stdlib）
#
# 字节级规格对齐 crates/duckle-secrets/src/lib.rs：
#   · AES-256-GCM，密钥 = workspace key 的 32 原始字节
#   · AAD = context + 0x1f + field      （aad_for(), :171）
#   · token = "enc:v2:" + base64(nonce12 || ciphertext || tag16)   （encrypt_value(), :185）
#
# S-box 由 GF(2^8) 求逆 + 仿射变换**算出来**，不是抄 256 个常数 —— 抄写错误是这类实现
# 最典型的静默缺陷，算出来的版本没有这个自由度。
# ═══════════════════════════════════════════════════════════════════════════════

def _gf_mul(a, b):
    """GF(2^8) 乘法，模 AES 的 x^8+x^4+x^3+x+1（0x11B）。"""
    p = 0
    for _ in range(8):
        if b & 1:
            p ^= a
        hi = a & 0x80
        a = (a << 1) & 0xFF
        if hi:
            a ^= 0x1B
        b >>= 1
    return p


def _build_sbox():
    table = []
    for i in range(256):
        # GF(2^8) 乘法逆；0 的逆定义为 0。a^254 = a^-1（费马小定理）。
        inv = 0
        if i:
            inv = 1
            for _ in range(254):
                inv = _gf_mul(inv, i)
        x = inv
        y = inv
        for _ in range(4):
            x = ((x << 1) | (x >> 7)) & 0xFF
            y ^= x
        table.append(y ^ 0x63)
    return bytes(table)


_SBOX = _build_sbox()
_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36]


def _expand_key(key):
    """AES-256 密钥扩展：Nk=8, Nr=14 ⇒ 15 组轮密钥（每组 4 个字，每字 4 字节）。"""
    if len(key) != 32:
        raise ValueError("AES-256 需要 32 字节密钥，收到 %d" % len(key))
    nk, nr = 8, 14
    w = [list(key[4 * i:4 * i + 4]) for i in range(nk)]
    for i in range(nk, 4 * (nr + 1)):
        t = list(w[i - 1])
        if i % nk == 0:
            t = t[1:] + t[:1]
            t = [_SBOX[b] for b in t]
            t[0] ^= _RCON[i // nk - 1]
        elif i % nk == 4:
            t = [_SBOX[b] for b in t]
        w.append([w[i - nk][j] ^ t[j] for j in range(4)])
    return w


def _aes256_encrypt_block(w, block):
    """单块 AES-256 加密。state 按列主序：s[4*c + r]（AES 标准字节序）。"""
    s = list(block)

    def add_rk(rnd):
        for c in range(4):
            col = w[4 * rnd + c]
            for r in range(4):
                s[4 * c + r] ^= col[r]

    def shift_rows():
        t = list(s)
        for r in range(1, 4):
            row = [t[4 * c + r] for c in range(4)]
            row = row[r:] + row[:r]
            for c in range(4):
                s[4 * c + r] = row[c]

    add_rk(0)
    for rnd in range(1, 14):
        for i in range(16):
            s[i] = _SBOX[s[i]]
        shift_rows()
        t = list(s)
        for c in range(4):
            a0, a1, a2, a3 = t[4 * c], t[4 * c + 1], t[4 * c + 2], t[4 * c + 3]
            s[4 * c] = _gf_mul(a0, 2) ^ _gf_mul(a1, 3) ^ a2 ^ a3
            s[4 * c + 1] = a0 ^ _gf_mul(a1, 2) ^ _gf_mul(a2, 3) ^ a3
            s[4 * c + 2] = a0 ^ a1 ^ _gf_mul(a2, 2) ^ _gf_mul(a3, 3)
            s[4 * c + 3] = _gf_mul(a0, 3) ^ a1 ^ a2 ^ _gf_mul(a3, 2)
        add_rk(rnd)
    for i in range(16):
        s[i] = _SBOX[s[i]]
    shift_rows()
    add_rk(14)
    return bytes(s)


_MASK128 = (1 << 128) - 1


def _gfmul128(x, y):
    """GF(2^128) 乘法，模 GCM 的 x^128+x^7+x^2+x+1（右移版，R = 0xe1||0^120）。"""
    z = 0
    v = y
    r = 0xE1000000000000000000000000000000
    for i in range(128):
        if (x >> (127 - i)) & 1:
            z ^= v
        if v & 1:
            v = (v >> 1) ^ r
        else:
            v >>= 1
    return z


def _ghash(h, data):
    y = 0
    for i in range(0, len(data), 16):
        blk = data[i:i + 16]
        if len(blk) < 16:
            blk = blk + b"\x00" * (16 - len(blk))
        y = _gfmul128(y ^ int.from_bytes(blk, "big"), h)
    return y


def _pad16(b):
    return b + b"\x00" * ((16 - len(b) % 16) % 16)


def aes256gcm_seal(key, nonce12, aad, plaintext):
    """返回 nonce12 || ciphertext || tag16（= RustCrypto aes-gcm `encrypt` 的输出形态）。"""
    if len(nonce12) != 12:
        raise ValueError("GCM nonce 必须是 12 字节")
    w = _expand_key(key)
    h = int.from_bytes(_aes256_encrypt_block(w, b"\x00" * 16), "big")
    j0 = nonce12 + b"\x00\x00\x00\x01"
    # CTR 从 inc32(J0) 起
    cb = (int.from_bytes(j0, "big") + 1) & _MASK128
    out = bytearray()
    for i in range(0, len(plaintext), 16):
        ks = _aes256_encrypt_block(w, (cb & _MASK128).to_bytes(16, "big"))
        chunk = plaintext[i:i + 16]
        out += bytes(a ^ b for a, b in zip(chunk, ks))
        cb = (cb + 1) & _MASK128
    ct = bytes(out)
    s = _ghash(h, _pad16(aad) + _pad16(ct) + (len(aad) * 8).to_bytes(8, "big")
               + (len(plaintext) * 8).to_bytes(8, "big"))
    tag = bytes(a ^ b for a, b in zip(_aes256_encrypt_block(w, j0), s.to_bytes(16, "big")))
    return nonce12 + ct + tag


def aes256gcm_open(key, blob, aad):
    """解 nonce12 || ciphertext || tag16；AAD 不符则抛 ValueError（GCM 认证失败）。"""
    if len(blob) < 12 + 16:
        raise ValueError("密文太短")
    nonce, body = blob[:12], blob[12:]
    ct, tag = body[:-16], body[-16:]
    w = _expand_key(key)
    h = int.from_bytes(_aes256_encrypt_block(w, b"\x00" * 16), "big")
    j0 = nonce + b"\x00\x00\x00\x01"
    s = _ghash(h, _pad16(aad) + _pad16(ct) + (len(aad) * 8).to_bytes(8, "big")
               + (len(ct) * 8).to_bytes(8, "big"))
    expect = bytes(a ^ b for a, b in zip(_aes256_encrypt_block(w, j0), s.to_bytes(16, "big")))
    if not _const_eq(expect, tag):
        raise ValueError("GCM 认证失败：AAD/密钥不符或密文被改")
    cb = (int.from_bytes(j0, "big") + 1) & _MASK128
    out = bytearray()
    for i in range(0, len(ct), 16):
        ks = _aes256_encrypt_block(w, (cb & _MASK128).to_bytes(16, "big"))
        chunk = ct[i:i + 16]
        out += bytes(a ^ b for a, b in zip(chunk, ks))
        cb = (cb + 1) & _MASK128
    return bytes(out)


def _const_eq(a, b):
    if len(a) != len(b):
        return False
    d = 0
    for x, y in zip(a, b):
        d |= x ^ y
    return d == 0


# ═══════════════════════════════════════════════════════════════════════════════
# duckle-secrets 语义层
# ═══════════════════════════════════════════════════════════════════════════════

def is_encrypted(s):
    """lib.rs:157 —— v1 是 legacy（无 AAD），v2 是现行。"""
    return s.startswith(ENC_PREFIX_V1) or s.startswith(ENC_PREFIX_V2)


def aad_for(context, field):
    """lib.rs:171 —— 0x1f 不在 id / 字段名里合法，所以拼接不歧义。"""
    return context.encode("utf-8") + b"\x1f" + field.encode("utf-8")


def seal(key, context, field, plaintext):
    nonce = os.urandom(12)
    blob = aes256gcm_seal(key, nonce, aad_for(context, field), plaintext.encode("utf-8"))
    return ENC_PREFIX_V2 + base64.b64encode(blob).decode("ascii")


def unseal(key, context, field, token):
    if token.startswith(ENC_PREFIX_V1):
        raise ValueError("enc:v1: 无 AAD 绑定，本脚本不处理 legacy 值")
    raw = base64.b64decode(token[len(ENC_PREFIX_V2):], validate=True)
    return aes256gcm_open(key, raw, aad_for(context, field)).decode("utf-8")


def key_path(ws):
    return os.path.join(ws, ".duckle", "keys", "secret.key")


def load_or_create_key(ws, create=True):
    """复用已有钥匙；**绝不覆盖**。返回 (key_bytes, 状态字符串)。"""
    path = key_path(ws)
    if os.path.exists(path):
        with open(path, "rb") as f:
            raw = f.read()
        if len(raw) != 32:
            raise KeyProblem(
                "既有钥匙不是 32 字节（%s，实际 %d 字节）—— 拒跑。"
                "覆盖它会孤立本工作区**所有**既有密文；请人工确认后再处理。"
                % (path, len(raw))
            )
        mode = os.stat(path).st_mode & 0o777
        if mode & 0o077:
            os.chmod(path, 0o600)
            return raw, "reused（权限从 %03o 收紧到 600）" % mode
        return raw, "reused"
    if not create:
        raise KeyProblem("钥匙不存在：%s（--dry-run 不建钥匙）" % path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    raw = os.urandom(32)
    # create_new + 0600：先建后 chmod 会留一个「世界可读」的窗口（TOCTOU）。
    # 并发上「先到者权威、后来者采纳盘上的」—— 与 lib.rs:73 的 workspace_key 同一取舍。
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(fd, raw)
    finally:
        os.close(fd)
    return raw, "minted"


# ── 连接档（profile）：把 env 键名 → 连接字段的映射写成数据，别散在代码里 ──────────
# 字段三元组：(连接字段名, 来源, 是否必填)。来源三种：env:VAR / file:PATH / literal:VALUE。
# 敏感字段**只允许** env: / file:（红线 3 在 parse_field 里强制）。
PROFILES = {
    # 湖：S3 兼容（天翼云 ZOS）。字段名对齐 crates/duckle-secrets/src/lib.rs 的
    # merge_generic_connection KEYS 白名单 + snk.minio 的表单键（catalog 实测）。
    "zos-s3": [
        ("kind", "literal:s3", True),
        ("endpoint", "env:ZOS_ENDPOINT", True),
        ("bucket", "env:ZOS_BUCKET", True),
        ("region", "env:ZOS_REGION", False),
        ("accessKey", "env:ZOS_ACCESS_KEY", True),
        ("secretKey", "env:ZOS_SECRET_KEY", True),
        ("urlStyle", "literal:path", True),
        # useSsl 接受 bool 或字符串（s3.rs:154 `as_bool().or_else(as_str != "false")`）；
        # 用 "true" 是为了和 UI 下拉框的取值形态一致（那个 select 的选项值是字符串）。
        ("useSsl", "literal:true", True),
    ],
    # 业务网关：REST bearer。authToken 是敏感字段；authType 不是。
    # token 的 env 键名由 --token-env 给（这里用 {token_env} 占位，运行期填）。
    "rest-bearer": [
        ("kind", "literal:rest", True),
        ("authType", "literal:bearer", True),
        ("authToken", "env:{token_env}", True),
    ],
    # 空档：只用 --set 时用
    "none": [],
}


def parse_field(spec, key):
    """'env:VAR' / 'file:/p' / 'literal:v' → (kind, arg)。"""
    if ":" not in spec:
        raise Usage("--set %s 的来源必须形如 env:VAR / file:PATH / literal:VALUE" % key)
    kind, arg = spec.split(":", 1)
    if kind not in ("env", "file", "literal"):
        raise Usage("--set %s 的来源类型 %r 不认识（只认 env/file/literal）" % (key, kind))
    if kind == "literal" and key in _SENSITIVE:
        raise Usage(
            "拒跑：%r 是敏感字段，不能用 literal: 传（会出现在命令行/ps/历史里）。"
            "请改用 env:VAR 或 file:PATH。" % key
        )
    return kind, arg


def resolve_source(spec, key):
    """返回 (值, 来源描述)。空/未设置 ⇒ (None, 描述)。**永不回显值**。"""
    kind, arg = parse_field(spec, key)
    if kind == "env":
        v = os.environ.get(arg)
        if v is None or v == "":
            return None, "env %s（未设置或为空）" % arg
        return v, "env %s" % arg
    if kind == "file":
        try:
            with open(arg, "r", encoding="utf-8") as f:
                v = f.read()
        except OSError as e:
            return None, "file %s（读不到：%s）" % (arg, e.__class__.__name__)
        # 单行密钥文件常见的尾换行；保留其它空白（密钥里可能真的有空格）
        v = v.rstrip("\r\n")
        if v == "":
            return None, "file %s（空文件）" % arg
        return v, "file %s" % arg
    return arg, "literal（非敏感）"


def fingerprint(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:12]


# ═══════════════════════════════════════════════════════════════════════════════
# 明文审计（写完自检 + --check-only 共用同一函数）
# ═══════════════════════════════════════════════════════════════════════════════

def find_plaintext_sensitive(obj, path=""):
    """返回违规的字段路径列表。

    判据 = 源码 transform()（lib.rs:237）**没封**、而它本该封的那些位置：
      · 字符串值：键名在 SENSITIVE_KEYS、非空、不是 enc: 开头、不是 ${...} 占位符 ⇒ 违规
      · 非字符串值（数字/布尔/对象/数组）挂在敏感键下 ⇒ 也违规
        （源码只封字符串，这一档会**静默留明文**，正典要的就是「不许静默产出明文」）
    """
    bad = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            here = "%s.%s" % (path, k) if path else k
            if k in _SENSITIVE and not isinstance(v, (dict, list)) and v is not None:
                if not isinstance(v, str):
                    bad.append("%s（非字符串，源码的 transform 不封它）" % here)
                elif v == "" or is_encrypted(v) or v.startswith("${"):
                    pass
                else:
                    bad.append(here)
            elif isinstance(v, (dict, list)):
                if k in _SENSITIVE and isinstance(v, list):
                    bad.append("%s（数组形态，源码的 transform 只封标量字符串）" % here)
                bad.extend(find_plaintext_sensitive(v, here))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            bad.extend(find_plaintext_sensitive(v, "%s[%d]" % (path, i)))
    return bad


def audit_file(path):
    """(违规列表, 已封计数)。文件读不开 ⇒ 抛 OSError。"""
    with open(path, "r", encoding="utf-8") as f:
        obj = json.load(f)
    return find_plaintext_sensitive(obj), count_sealed(obj)


def count_sealed(obj):
    n = 0
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in _SENSITIVE and isinstance(v, str) and is_encrypted(v):
                n += 1
            elif isinstance(v, (dict, list)):
                n += count_sealed(v)
    elif isinstance(obj, list):
        for v in obj:
            n += count_sealed(v)
    return n


# ═══════════════════════════════════════════════════════════════════════════════
# 主流程
# ═══════════════════════════════════════════════════════════════════════════════

def plan_fields(args):
    """(字段名 → 来源) 的有序映射；profile 在前，--set 覆盖/追加。"""
    if args.profile not in PROFILES:
        raise Usage("未知 profile %r；可选：%s" % (args.profile, ", ".join(sorted(PROFILES))))
    if args.profile == "rest-bearer" and not args.token_env:
        raise Usage("profile rest-bearer 必须给 --token-env VAR（token 的 env 键名，脚本不替你猜）")
    out = {}
    required = {}
    for key, source, req in PROFILES[args.profile]:
        out[key] = source.replace("{token_env}", args.token_env or "")
        required[key] = req
    for item in args.set or []:
        if "=" not in item:
            raise Usage("--set 需形如 KEY=SOURCE，收到 %r" % item)
        k, spec = item.split("=", 1)
        out[k] = spec
        required[k] = True
    return out, required


def cmd_check_only(paths):
    files = []
    for p in paths:
        if os.path.isdir(p):
            for name in sorted(os.listdir(p)):
                if name.endswith(".json"):
                    files.append(os.path.join(p, name))
        else:
            files.append(p)
    if not files:
        print("%s: --check-only 没找到任何 .json" % PROG, file=sys.stderr)
        return 2
    total_bad = 0
    for f in files:
        try:
            bad, sealed = audit_file(f)
        except (OSError, ValueError) as e:
            print("UNREADABLE %s（%s）" % (f, e.__class__.__name__), file=sys.stderr)
            total_bad += 1
            continue
        if bad:
            total_bad += len(bad)
            for b in bad:
                # 只点名，**不打印值**
                print("PLAINTEXT %s :: %s" % (f, b), file=sys.stderr)
        else:
            print("clean %s（已封 %d 个敏感字段）" % (f, sealed))
    if total_bad:
        print(
            "自检未过：%d 处明文敏感字段。管线里写 connectionRef 前必须先封（用 profile / --set 重跑本脚本）。"
            % total_bad,
            file=sys.stderr,
        )
        return 3
    return 0


def cmd_setup(args):
    ws = os.path.abspath(args.workspace)
    if not os.path.isdir(ws):
        raise Usage("--workspace %s 不是目录" % ws)
    if not args.id or "/" in args.id or args.id.startswith("."):
        raise Usage("--id 必须是简单的连接名（账套无关），收到 %r" % args.id)

    fields, required = plan_fields(args)
    if not fields:
        raise Usage("没有任何字段要写：给 --profile 或 --set")

    conn_path = os.path.join(ws, "connections", "%s.json" % args.id)

    # ① 解析来源（先把所有来源解析完，缺必填就整单拒跑 —— 不写半条连接）
    desired = {}
    provenance = {}
    order = []
    missing = []
    for key in fields:
        value, src = resolve_source(fields[key], key)
        order.append(key)
        provenance[key] = src
        if value is None:
            if required.get(key, True):
                missing.append("  · %s ← %s" % (key, src))
            continue
        desired[key] = value
    if missing:
        print("拒跑：以下必填来源没取到值（**不写任何文件**）：", file=sys.stderr)
        for m in missing:
            print(m, file=sys.stderr)
        return 4

    # ② 既有文件（幂等 / 轮换的基准）
    existing = None
    if os.path.exists(conn_path):
        try:
            with open(conn_path, "r", encoding="utf-8") as f:
                existing = json.load(f)
        except ValueError as e:
            raise Usage("既有连接文件不是合法 JSON：%s（%s）" % (conn_path, e))
        if not isinstance(existing, dict):
            raise Usage("既有连接文件顶层不是对象：%s" % conn_path)
        # 既有明文敏感字段：不在本次 sources 覆盖范围内的，**拒绝**替它封（不知道值），
        # 而是 fail loud —— 免得「写完自检」变成一句永远为真的空话。
        stale = [b for b in find_plaintext_sensitive(existing)
                 if b.split("（")[0].split(".")[0] not in desired]
        if stale:
            print(
                "拒跑：%s 里已有明文敏感字段，而本次没给它们的值（不知道明文就拿不到来源）：" % conn_path,
                file=sys.stderr,
            )
            for b in stale:
                print("  · %s" % b, file=sys.stderr)
            print(
                "  把它们经 profile / --set（env:VAR 或 file:PATH）喂进来，本次一并封掉。",
                file=sys.stderr,
            )
            return 3

    # ③ 有了要封的东西才动钥匙（--dry-run 不建钥匙）
    key = None
    key_state = "（本次不需要）"

    def ensure_key():
        nonlocal key, key_state
        if key is None:
            key, key_state = load_or_create_key(ws, create=not args.dry_run)
        return key

    if any(k in _SENSITIVE and _sealable(desired[k]) for k in desired):
        if args.dry_run and not os.path.exists(key_path(ws)):
            key_state = "dry-run（无既有钥匙，本次不建）"
        else:
            ensure_key()

    # ③′ --dry-run 且工作区还没有钥匙：没有可比对的基准，只报计划，不试封。
    #     （试封要么建钥匙——违反 dry-run——要么用临时密钥解既存密文，会把「解不开」误报成事故。）
    if args.dry_run and key is None:
        print("== duckle 加密连接 setup（dry-run / 尚无钥匙）==")
        print("workspace  : %s" % ws)
        print("connection : %s  →  %s" % (args.id, conn_path))
        print("key        : %s  %s" % (key_path(ws), key_state))
        for key_name in order:
            if key_name not in desired:
                print("field %-12s SKIP       （%s）" % (key_name, provenance[key_name]))
            elif key_name in _SENSITIVE and _sealable(desired[key_name]):
                print("field %-12s WILL SEAL  len=%d sha12=%s  （%s）"
                      % (key_name, len(desired[key_name]), fingerprint(desired[key_name]),
                         provenance[key_name]))
            else:
                print("field %-12s plaintext  = %s" % (key_name, desired[key_name]))
        print("result     : dry-run，未落盘（未建钥匙、未写连接文件）")
        return 0

    # ④ 合并：既有键序保持，新键按 profile 声明序追加
    merged = dict(existing) if existing else {}
    changed = []
    kept = []
    for key_name in order:
        if key_name not in desired:
            continue
        want = desired[key_name]
        if key_name in _SENSITIVE and _sealable(want):
            cur = merged.get(key_name)
            if isinstance(cur, str) and is_encrypted(cur):
                # 已有密文：先解出来和明文比 —— 相同则**原样保留**（逐字节幂等），
                # 不同则是轮换，重封。解不开 ⇒ 拒跑（绝不覆盖别人的密文）。
                try:
                    same = unseal(ensure_key(), args.id, key_name, cur) == want
                except ValueError as e:
                    raise KeyProblem(
                        "既有密文 %s 用本工作区钥匙解不开（%s）—— 拒跑。"
                        "**不要**覆盖钥匙；先查清这份连接是哪个工作区/哪把钥匙封的。"
                        % (key_name, e.__class__.__name__)
                    )
                if same:
                    kept.append(key_name)
                    continue
                merged[key_name] = seal(ensure_key(), args.id, key_name, want)
                changed.append(key_name)
                continue
            merged[key_name] = seal(ensure_key(), args.id, key_name, want)
            changed.append(key_name)
        else:
            if merged.get(key_name) == want:
                kept.append(key_name)
            else:
                merged[key_name] = want
                changed.append(key_name)

    # ⑤ 写完自检的**前置**：内存里就查一遍（不合规 ⇒ 一个字节都不落盘）
    bad = find_plaintext_sensitive(merged)
    if bad:
        print("拒跑：本次要写的连接文件里仍有明文敏感字段（**未落盘**）：", file=sys.stderr)
        for b in bad:
            print("  · %s" % b, file=sys.stderr)
        return 3

    # ⑥ 报告（只打键名 / 来源 / 长度 / 指纹）
    print("== duckle 加密连接 setup ==")
    print("workspace  : %s" % ws)
    print("connection : %s  →  %s" % (args.id, conn_path))
    print("key        : %s  %s" % (key_path(ws), key_state))
    for key_name in order:
        if key_name not in desired:
            print("field %-12s SKIP   （%s）" % (key_name, provenance[key_name]))
            continue
        want = desired[key_name]
        sealed_now = key_name in _SENSITIVE and _sealable(want)
        tag = "已存在未改" if key_name in kept else ("SEALED" if sealed_now else "plaintext")
        if key_name in _SENSITIVE:
            print("field %-12s %-10s len=%d sha12=%s  （%s）"
                  % (key_name, tag, len(want), fingerprint(want), provenance[key_name]))
        else:
            # 非敏感值打印出来是安全的，且是有用的核对面（kind / urlStyle / bucket）
            print("field %-12s %-10s = %s" % (key_name, tag, want))

    if args.dry_run:
        print("result     : dry-run，未落盘")
        return 0

    text = json.dumps(merged, indent=2, ensure_ascii=False) + "\n"
    if existing is not None and existing == merged:
        print("result     : 未改（文件已与目标一致，连 mtime 都不动）")
        return 0

    os.makedirs(os.path.dirname(conn_path), exist_ok=True)
    tmp = conn_path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, conn_path)   # 原子替换：连接文件永不半写
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

    # ⑦ 写完自检：回读**落盘文件**（不是内存里的那份）
    bad2, sealed = audit_file(conn_path)
    if bad2:
        print("自检未过：刚落盘的文件里有明文敏感字段：", file=sys.stderr)
        for b in bad2:
            print("  · %s" % b, file=sys.stderr)
        return 3
    print("self-check : clean（%d 个敏感字段已封）" % sealed)
    print("result     : wrote %s（改动 %d 项：%s；未改 %d 项）"
          % (conn_path, len(changed), ", ".join(changed) or "-", len(kept)))
    return 0


def main(argv):
    ap = argparse.ArgumentParser(
        prog=PROG, description="把容器 env 里的凭据加密写成 duckle 连接文件（connectionRef 通路）。",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--workspace", "-w", help="duckle 工作区根（容器内通常是 /workspace）")
    ap.add_argument("--id", "-i", help="连接 id；**账套无关**（zos / lemeng …），见文件头约定")
    ap.add_argument("--profile", "-p", default="none", choices=sorted(PROFILES),
                    help="字段档：%s" % ", ".join(sorted(PROFILES)))
    ap.add_argument("--set", action="append", metavar="KEY=SOURCE",
                    help="追加/覆盖字段；SOURCE = env:VAR | file:PATH | literal:VALUE")
    ap.add_argument("--token-env", default="", help="rest-bearer 档的 token env 键名")
    ap.add_argument("--dry-run", action="store_true", help="只报告，不建钥匙、不落盘")
    ap.add_argument("--check-only", action="append", metavar="PATH",
                    help="只读复查：给文件或目录（目录则扫 *.json），有明文敏感字段即非零退出")
    ap.add_argument("--selftest", action="store_true",
                    help="跑内建 KAT（AES-256-GCM 已知答案），不碰任何工作区")
    args = ap.parse_args(argv)

    try:
        if args.selftest:
            return cmd_selftest()
        if args.check_only:
            return cmd_check_only(args.check_only)
        if not args.workspace:
            raise Usage("必须给 --workspace（不设默认值，避免误写到别处）")
        if not args.id:
            raise Usage("必须给 --id")
        return cmd_setup(args)
    except Usage as e:
        print("%s: %s" % (PROG, e), file=sys.stderr)
        return 2
    except KeyProblem as e:
        print("%s: %s" % (PROG, e), file=sys.stderr)
        return 5


def cmd_selftest():
    """KAT：已知答案测试。向量由**独立实现**生成（见 kat.json 的 provenance 字段）。"""
    if not os.path.exists(KAT_PATH):
        print("%s: 找不到 KAT %s" % (PROG, KAT_PATH), file=sys.stderr)
        return 2
    with open(KAT_PATH, "r", encoding="utf-8") as f:
        kat = json.load(f)
    failures = 0
    for i, vec in enumerate(kat["vectors"]):
        key = bytes.fromhex(vec["key_hex"])
        nonce = bytes.fromhex(vec["nonce_hex"])
        aad = aad_for(vec["context"], vec["field"])
        got = aes256gcm_seal(key, nonce, aad, vec["plaintext"].encode("utf-8")).hex()
        if got != vec["sealed_hex"]:
            failures += 1
            print("KAT #%d 不符：期望 %s 得到 %s" % (i, vec["sealed_hex"][:32], got[:32]), file=sys.stderr)
        try:
            back = aes256gcm_open(key, bytes.fromhex(vec["sealed_hex"]), aad).decode("utf-8")
            if back != vec["plaintext"]:
                failures += 1
                print("KAT #%d 回解不符" % i, file=sys.stderr)
        except ValueError as e:
            failures += 1
            print("KAT #%d 回解失败：%s" % (i, e), file=sys.stderr)
        # 反向：AAD 换字段名必须解不开
        try:
            aes256gcm_open(key, bytes.fromhex(vec["sealed_hex"]), aad_for(vec["context"], vec["field"] + "x"))
            failures += 1
            print("KAT #%d 反向失败：换字段名竟然解开了" % i, file=sys.stderr)
        except ValueError:
            pass
    if failures:
        print("selftest FAILED（%d）" % failures, file=sys.stderr)
        return 1
    print("selftest ok（%d vectors，来源 %s）" % (len(kat["vectors"]), kat.get("provenance", "?")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
