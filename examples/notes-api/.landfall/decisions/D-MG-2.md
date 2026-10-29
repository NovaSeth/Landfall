---
schema: 1
id: D-MG-2
title: Request bodies are limited to 16 KiB
status: active
kind: general
date: 2026-10-29
author: MG
supersedes: []
supersededBy: null
scope: [src/app.mjs]
allowsTestRemoval: []
---

## What

Request bodies are limited to 16 KiB

## Why

A note is at most 10,000 characters plus a title, so 16 KiB leaves room for JSON escaping; the limit stops a client from exhausting server memory with one request.

## Cost if wrong

A client that sends notes with heavy escaping near the body cap gets 413 and must shorten the note.

## Alternatives

None recorded.
