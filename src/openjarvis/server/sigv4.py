"""AWS Signature Version 4 for a few signed calls, with the standard library.

The G1 mirror (hq 0020 D4) is a Lambda Function URL with ``AWS_IAM`` auth,
called by an IAM user's access key kept in a named profile of the shared AWS
credentials file. That is all this module covers: static keys (plus an
optional session token) from ``~/.aws/credentials`` or ``~/.aws/config``, and
header signing (``Authorization`` plus ``X-Amz-Date``). No SSO, no
assume-role, no query signing. It never logs a key, a signature or a URL.
"""

from __future__ import annotations

import configparser
import hashlib
import hmac
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlsplit

ALGORITHM = "AWS4-HMAC-SHA256"


@dataclass(frozen=True)
class Credentials:
    access_key: str
    secret_key: str
    token: str | None = None

    def __repr__(self) -> str:  # never print the secret
        return f"Credentials(access_key={self.access_key[:4]}…)"


def _aws_file(env: str, name: str) -> Path:
    value = os.environ.get(env)
    return Path(value).expanduser() if value else Path.home() / ".aws" / name


def load_profile(profile: str) -> Credentials | None:
    """The profile's static keys, from the credentials file first, then the
    config file's ``[profile <name>]``. None when neither has both keys."""
    sources = (
        (_aws_file("AWS_SHARED_CREDENTIALS_FILE", "credentials"), profile),
        (_aws_file("AWS_CONFIG_FILE", "config"), f"profile {profile}"),
    )
    for path, section in sources:
        parser = configparser.RawConfigParser()
        try:
            parser.read(path, encoding="utf-8")
        except (OSError, configparser.Error):
            continue
        if not parser.has_section(section):
            continue
        key = parser.get(section, "aws_access_key_id", fallback="").strip()
        secret = parser.get(section, "aws_secret_access_key", fallback="").strip()
        if key and secret:
            token = parser.get(section, "aws_session_token", fallback="").strip()
            return Credentials(key, secret, token or None)
    return None


def lambda_url_region(url: str) -> str | None:
    """``<id>.lambda-url.<region>.on.aws`` → ``<region>``."""
    parts = (urlsplit(url).hostname or "").split(".")
    if len(parts) >= 5 and parts[1] == "lambda-url" and parts[-2:] == ["on", "aws"]:
        return parts[2]
    return None


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _canonical_query(query: str) -> str:
    pairs = []
    for part in query.split("&") if query else []:
        name, _, value = part.partition("=")
        pairs.append((quote(name, safe="-_.~"), quote(value, safe="-_.~")))
    return "&".join(f"{n}={v}" for n, v in sorted(pairs))


def sign(
    method: str,
    url: str,
    *,
    region: str,
    service: str,
    credentials: Credentials,
    body: bytes = b"",
    headers: dict[str, str] | None = None,
    now: datetime | None = None,
) -> dict[str, str]:
    """The request's headers with ``X-Amz-Date``, the session token if any,
    and ``Authorization``. Every header passed in is signed."""
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date = amz_date[:8]
    parts = urlsplit(url)
    host = parts.netloc
    out = {**(headers or {}), "Host": host, "X-Amz-Date": amz_date}
    if credentials.token:
        out["X-Amz-Security-Token"] = credentials.token

    canonical_headers = {k.lower(): " ".join(str(v).split()) for k, v in out.items()}
    signed = ";".join(sorted(canonical_headers))
    payload_hash = hashlib.sha256(body).hexdigest()
    canonical_request = "\n".join(
        [
            method.upper(),
            quote(parts.path or "/", safe="/-_.~"),
            _canonical_query(parts.query),
            "".join(f"{k}:{canonical_headers[k]}\n" for k in sorted(canonical_headers)),
            signed,
            payload_hash,
        ]
    )
    scope = f"{date}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join(
        [
            ALGORITHM,
            amz_date,
            scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    key = _hmac(("AWS4" + credentials.secret_key).encode("utf-8"), date)
    for part in (region, service, "aws4_request"):
        key = _hmac(key, part)
    signature = hmac.new(
        key, string_to_sign.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    out["Authorization"] = (
        f"{ALGORITHM} Credential={credentials.access_key}/{scope}, "
        f"SignedHeaders={signed}, Signature={signature}"
    )
    return out
