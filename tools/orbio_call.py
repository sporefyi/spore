#!/usr/bin/env python3
"""Call Claude via the Orbio vault-backed gateway using a prompt file.

Auth is handled inside orbio-chat-vault.py via the authd surrogate
(custom.orbio) — this script never sees or touches any raw credential.

Usage:
  orbio_call.py --prompt-file PROMPT.md --out RESPONSE.md
                [--model anthropic/claude-sonnet-5.5]
                [--system-file SYSTEM.md]
                [--max-tokens 8000] [--temperature 0.3]

Exit codes: 0 ok | 2 bad args | 3 gateway/model failure.
"""
import subprocess
import sys


def arg(flag, default=None):
    if flag in sys.argv:
        i = sys.argv.index(flag)
        return sys.argv[i + 1] if i + 1 < len(sys.argv) else default
    return default


def main():
    prompt_file = arg("--prompt-file")
    out = arg("--out")
    if not prompt_file or not out:
        print("usage: orbio_call.py --prompt-file P --out O [--model M] "
              "[--system-file S] [--max-tokens 8000] [--temperature 0.3]",
              file=sys.stderr)
        return 2
    with open(prompt_file, "r", encoding="utf-8") as f:
        prompt = f.read()
    if not prompt.strip():
        print("orbio_call: prompt file is empty", file=sys.stderr)
        return 2
    cmd = ["python3",
           "/home/hatch/workspace/skills/idea-launcher/bin/orbio-chat-vault.py",
           "--model", arg("--model", "anthropic/claude-sonnet-5.5"),
           "--user", prompt,
           "--max-tokens", arg("--max-tokens", "8000"),
           "--temperature", arg("--temperature", "0.3")]
    system_file = arg("--system-file")
    if system_file:
        with open(system_file, "r", encoding="utf-8") as f:
            cmd += ["--system", f.read()]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        print("orbio_call: gateway timed out after 300s", file=sys.stderr)
        return 3
    if proc.returncode != 0:
        print("orbio_call: gateway failed:",
              proc.stderr.strip()[:500], file=sys.stderr)
        return 3
    with open(out, "w", encoding="utf-8") as f:
        f.write(proc.stdout)
    print("orbio_call: wrote %d chars to %s" % (len(proc.stdout), out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
