---
schema: 1
id: D-MG-1
title: Notes are stored in one JSON file, written to a temp file and renamed
status: active
kind: general
date: 2026-10-29
author: MG
supersedes: []
supersededBy: null
scope: [src/store.mjs]
allowsTestRemoval: []
---

## What

Notes are stored in one JSON file, written to a temp file and renamed

## Why

A rename is atomic on one file system, so a crash mid-write never leaves half a file; one file is enough for a small service and keeps it dependency-free.

## Cost if wrong

Every write rewrites the whole file, which gets slow past a few thousand notes; then a real database is the next step.

## Alternatives

None recorded.
