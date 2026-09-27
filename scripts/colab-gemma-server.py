"""Run the benchmarked Gemma llama-server inside a Colab T4 runtime."""

import glob
import os
import pathlib
import subprocess
import sys
import time
import urllib.request

from huggingface_hub import hf_hub_download


TAG = "b11205"
RELEASE = f"https://github.com/ggml-org/llama.cpp/releases/download/{TAG}"
ROOT = pathlib.Path("/content")
BIN_DIR = ROOT / "llama"
MODEL_DIR = ROOT / "models"
PORT = 8092


def download_archive(name: str, destination: pathlib.Path) -> None:
    archive = ROOT / name
    print(f"Downloading {name}", flush=True)
    urllib.request.urlretrieve(f"{RELEASE}/{name}", archive)
    subprocess.run(["tar", "-xzf", str(archive), "-C", str(destination)], check=True)
    archive.unlink()


def main() -> None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2) as response:
            if b'"ok"' in response.read():
                print("llama-server already healthy", flush=True)
                return
    except Exception:
        pass
    BIN_DIR.mkdir(exist_ok=True)
    MODEL_DIR.mkdir(exist_ok=True)
    servers = glob.glob(str(BIN_DIR / "**/llama-server"), recursive=True)
    if not servers:
        download_archive(f"llama-{TAG}-bin-ubuntu-cuda-12.8-x64.tar.gz", BIN_DIR)
        servers = glob.glob(str(BIN_DIR / "**/llama-server"), recursive=True)
    server = servers[0]
    lib_dir = os.path.dirname(server)
    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = f"{lib_dir}:/usr/lib64-nvidia:{env.get('LD_LIBRARY_PATH', '')}"
    missing = subprocess.run(["ldd", server], capture_output=True, text=True, env=env, check=True).stdout
    if "not found" in missing:
        download_archive(f"cudart-llama-{TAG}-bin-ubuntu-cuda-12.8-x64.tar.gz", pathlib.Path(lib_dir))
    repo = "unsloth/gemma-4-E4B-it-qat-GGUF"
    model = hf_hub_download(repo, "gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf", local_dir=MODEL_DIR)
    draft = hf_hub_download(repo, "mtp-gemma-4-E4B-it.gguf", local_dir=MODEL_DIR)
    print("Model files ready; starting llama-server", flush=True)
    command = [server, "-m", model, "--host", "127.0.0.1", "--port", str(PORT),
               "--jinja", "--no-mmproj", "-ngl", "99", "-np", "1", "-c", "2048",
               "-md", draft, "--spec-type", "draft-mtp", "--spec-draft-n-max", "4"]
    with open(ROOT / "moat-llama.log", "ab", buffering=0) as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                   env=env, start_new_session=True)
    (ROOT / "moat-llama.pid").write_text(str(process.pid))
    for _ in range(180):
        if process.poll() is not None:
            raise RuntimeError(f"llama-server exited with {process.returncode}")
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2) as response:
                if b'"ok"' in response.read():
                    print("llama-server healthy", flush=True)
                    return
        except Exception:
            time.sleep(1)
    raise TimeoutError("llama-server did not become healthy")


if __name__ == "__main__":
    if "--watch" in sys.argv:
        while True:
            try:
                main()
            except Exception as error:
                print(f"Gemma restart failed: {error}", flush=True)
            time.sleep(15)
    else:
        main()
