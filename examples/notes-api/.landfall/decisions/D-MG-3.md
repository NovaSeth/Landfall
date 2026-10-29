---
schema: 1
id: D-MG-3
title: "T-MG-3: review closed at the 2-round cap; F2 (the body keeps flowing after the 413) goes to the findings backlog"
status: active
kind: review-close
date: 2026-10-29
author: MG
supersedes: []
supersededBy: null
scope: []
allowsTestRemoval: []
task: T-MG-3
remaining: [F2]
---

## What

T-MG-3: review closed at the 2-round cap; F2 (the body keeps flowing after the 413) goes to the findings backlog

## Why

Round 1 found F1 and F2; the fix round fixed F1 and paused the request on overflow, but the re-review showed that finishing the response resumes the request on Node 26, so F2 stays open. The limit, the 415 and the safe 500 work and are tested; F2 is a bounded over-read after the 413, fixed next as its own task from the backlog.

## Cost if wrong

Until the follow-up lands, a client can make the server read up to its socket buffer of extra body bytes after the 413, not unbounded memory.

## Alternatives

None recorded.
