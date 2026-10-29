---
schema: 1
id: D-MG-4
title: "T-MG-4: the timing-dependent paused test is replaced by a deterministic byte-count test"
status: active
kind: test-removal
date: 2026-10-29
author: MG
supersedes: []
supersededBy: null
scope: []
allowsTestRemoval: ["[\"\",\"after the overflow the request is paused: at most one chunk passes the limit\",1]"]
---

## What

T-MG-4: the timing-dependent paused test is replaced by a deterministic byte-count test

## Why

The old test asserted req.isPaused() after the 413, which passed or failed by timing (it failed in the T-MG-3 merge gate); the new test counts every byte the request emits through an in-memory socket and fails on the old code.

## Cost if wrong

If the new test misses a path the old one caught, an over-read after the 413 could return unnoticed.

## Alternatives

None recorded.
