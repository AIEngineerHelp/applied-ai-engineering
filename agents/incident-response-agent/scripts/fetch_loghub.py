"""Download the Loghub-2.0 2k sample logs into data/loghub/2k.

    python3 scripts/fetch_loghub.py        (standard library only; no install needed)

About 20 MB. The logs are licensed for research and academic use: cite Loghub and keep
data/loghub/2k/LICENSE.txt with any copy (https://github.com/logpai/loghub).
"""
import argparse
import hashlib
import io
import json
import shutil
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "data" / "loghub" / "2k"
MANIFEST_PATH = ROOT / "data" / "loghub" / "MANIFEST.json"
ARCHIVE_URL = "https://github.com/logpai/loghub-2.0/archive/refs/heads/main.zip"
EXPECTED = ["BGL", "Hadoop", "HDFS", "OpenSSH", "Zookeeper"]


def download(url: str) -> bytes:
    """urllib first; if the Python install has no CA certificates (common with python.org
    builds on macOS), retry with certifi, then with curl."""
    try:
        with urllib.request.urlopen(url, timeout=300) as response:
            return bytes(response.read())
    except urllib.error.URLError as e:
        if "CERTIFICATE_VERIFY_FAILED" not in str(e):
            raise
    try:
        import certifi

        ctx = ssl.create_default_context(cafile=certifi.where())
        with urllib.request.urlopen(url, timeout=300, context=ctx) as response:
            return bytes(response.read())
    except ImportError:
        pass
    if shutil.which("curl"):
        print("Python has no CA certificates; downloading with curl instead.")
        return subprocess.run(["curl", "-fsSL", url], check=True, capture_output=True).stdout
    sys.exit("SSL certificate verification failed. On macOS run 'Install Certificates.command' "
             "from your Python folder, or run: uv run python scripts/fetch_loghub.py")


def fetch_loghub_2k() -> None:
    print(f"Downloading {ARCHIVE_URL} ...")
    content = download(ARCHIVE_URL)
    checksum = hashlib.sha256(content).hexdigest()
    print(f"SHA-256 {checksum}")

    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        # The top folder is named after the branch (e.g. "loghub-2.0-main/").
        prefix = next((n.split("2k_dataset/")[0] + "2k_dataset/" for n in archive.namelist()
                       if "/2k_dataset/" in n), None)
        if prefix is None:
            sys.exit("No 2k_dataset/ folder in the archive; the upstream layout changed.")
        TARGET.mkdir(parents=True, exist_ok=True)
        for name in archive.namelist():
            if not name.startswith(prefix) or name.endswith("/"):
                continue
            dest = TARGET / name[len(prefix):]
            dest.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(name) as src, open(dest, "wb") as out:
                shutil.copyfileobj(src, out)

    missing = [d for d in EXPECTED if not (TARGET / d / f"{d}_2k.log_structured.csv").exists()]
    if missing:
        sys.exit(f"Download incomplete, missing: {missing}")
    MANIFEST_PATH.write_text(json.dumps({"datasets": {"loghub_2k": {
        "version": "2.0", "source": ARCHIVE_URL, "checksum": checksum, "tier": "T0"}}},
        indent=2) + "\n")
    print(f"Done: {TARGET} ({len([p for p in TARGET.iterdir() if p.is_dir()])} datasets)")


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch the Loghub-2.0 2k sample datasets")
    parser.parse_args()
    fetch_loghub_2k()


if __name__ == "__main__":
    main()
