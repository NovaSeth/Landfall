#!/usr/bin/env bash
# Builds the run workspace (the current directory) from this case's visible fixture only:
# copies fixture/ and commits it as the first commit of a fresh git repository.
set -eu
case_dir="$(cd "$(dirname "$0")" && pwd)"
cp -R "$case_dir/fixture/." .
git -c init.defaultBranch=main init -q .
git symbolic-ref HEAD refs/heads/main
git add -A
git -c user.name="Eval Fixture" -c user.email="fixture@example.invalid" -c commit.gpgsign=false \
  commit -q -m "Initial state"
