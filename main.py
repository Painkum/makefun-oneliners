"""make.fun entry: copies this branch's entry file to /output.

Each branch of this repository is one bounty's entry. The text (entry.txt) or the
image (entry.png) beside this file is the whole entry; this program copies it byte
for byte, so every run writes the same bytes with no network.
"""
import os
import shutil

here = os.path.dirname(os.path.abspath(__file__))
# Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output.
out_dir = os.environ.get("MAKEFUN_OUTPUT_DIR", "/output")
os.makedirs(out_dir, exist_ok=True)
for name in ("entry.txt", "entry.png"):
    src = os.path.join(here, name)
    if os.path.exists(src):
        shutil.copyfile(src, os.path.join(out_dir, name))
