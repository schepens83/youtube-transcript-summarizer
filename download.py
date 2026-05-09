# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "requests",
# ]
# ///

import shutil
import subprocess
import pathlib
import sys

import requests

URLS_FILE = pathlib.Path("urls.txt")
OUT_DIR = pathlib.Path("mp3s")

PODCAST_URL = "https://schepens.cc/podcast/episodes"
PODCAST_USER = "schepens.cc"
PODCAST_PASS = "the_world_is_my"


def download_all(urls):
    for url in urls:
        print(f"[download] {url}")
        result = subprocess.run([
            "yt-dlp",
            "-x",
            "--audio-format", "mp3",
            "--audio-quality", "0",
            "-o", str(OUT_DIR / "%(title)s.%(ext)s"),
            url,
        ])
        if result.returncode != 0:
            print(f"[error] Download failed: {url}", file=sys.stderr)
            sys.exit(1)


def sanitize(mp3s):
    cleaned = []
    for mp3 in mp3s:
        name = mp3.stem
        name = "".join(c if c.isalnum() or c in " -" else " " for c in name)
        name = " ".join(name.split())
        new_path = mp3.with_name(name + ".mp3")
        if new_path != mp3:
            mp3.rename(new_path)
        cleaned.append(new_path)
    return cleaned


def upload_all(mp3s):
    for mp3 in mp3s:
        print(f"[upload] {mp3.name}")
        with mp3.open("rb") as f:
            response = requests.post(
                PODCAST_URL,
                auth=(PODCAST_USER, PODCAST_PASS),
                headers={"Accept": "application/json"},
                files={"episode[audio]": (mp3.name, f, "audio/mpeg")},
                data={"episode[title]": mp3.stem},
            )
        if not response.ok:
            print(f"[error] Upload failed: {response.status_code} {response.text}", file=sys.stderr)
            sys.exit(1)


def cleanup():
    shutil.rmtree(OUT_DIR)
    print("[cleanup] mp3s removed.")


def main():
    if not URLS_FILE.exists():
        print(f"Create {URLS_FILE} with one YouTube URL per line.")
        sys.exit(1)

    urls = [
        line.strip()
        for line in URLS_FILE.read_text().splitlines()
        if line.strip() and not line.startswith("#")
    ]

    if not urls:
        print("No URLs found in urls.txt.")
        sys.exit(0)

    print(f"{len(urls)} URL(s) to process.")
    OUT_DIR.mkdir(exist_ok=True)

    download_all(urls)

    mp3s = sorted(OUT_DIR.glob("*.mp3"))
    if not mp3s:
        print("[error] No MP3s found after download.", file=sys.stderr)
        sys.exit(1)

    mp3s = sanitize(mp3s)
    upload_all(mp3s)
    cleanup()
    URLS_FILE.write_text("")
    print("Done.")


if __name__ == "__main__":
    main()
