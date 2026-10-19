# Discovery

**Purpose:** a MUST / NICE / LATER / NO scope backed by evidence, and one data world for mockups, code and tests. **Reads:** orchestrator, research and synthesis agents, designer, PO. **When:** a new product or an MVP scope decision, before the spec and the first mockup.

**Section map**
- §Phase 0 and streams — own context and need codes, one question per agent, stream file, dossiers, URL register.
- §Evidence — sources, quotes, numbers, absence, one metrics window.
- §Fetching — raw pages outside context, gaps with causes, store reviews, link checks.
- §Analysis — controlled pairs, saturation, three lists, ranking, advise-against, flagship hypotheses.
- §Merging and synthesis — blocks, cross-checks, the running facts synthesis, confidence.
- §Interviews — layers, verdicts, spontaneous or prompted, limits, privacy.
- §Decision report — parts, generated data, scope classes, item cards, risks, framing, PO decision.
- §Existing system — mapping it, checking research figures, unstudied modules.
- §Data world — one world for mockups, fixtures, mock mode and assertions.

## Pack: discovery

### Phase 0 and streams
**DSC-1.** Before any agent researches outside, the orchestrator writes the project's own context (`research/0-own-context.md`): need codes `N<n>`, each with a status (hypothesis, single source, confirmed), and a source for every number.
**DSC-2.** Every finding, ranking row, scope item and mockup flow MUST cite a need code `N<n>`, because without it nobody can trace which need a feature came from.
**DSC-3.** One stream = one agent, one file `research/<X>-<name>.md` and one question; all streams get the same shared brief and need codes.
**DSC-4.** Default streams: A domestic competitors, withdrawn ones too · B the same category abroad · C adjacent technologies and platform APIs (wow effect, feasibility, legal limits) · D patterns from other industries, platform guidelines, law and standards · E what nobody has done that is feasible and hard to copy.
**DSC-5.** A stream file opens with the metrics read date, scope, conventions, counters (products, register URLs, image URLs, gaps, queries) and the need-code legend.
**DSC-6.** Describe each product in 9 points: platforms, links, metrics with their read date, declared features quoted verbatim, gaps against a full product, user opinions, screenshots, the maker's quote on its main use, prices.
**DSC-7.** A stream ends with the gaps table, the URL register `[U-<X>01]` that the text cites by number, the image list and product cards for a reader who does not know the products.
**DSC-8.** Append to the URL register and the gaps after every source, because a broken run loses a register written at the end.

### Evidence
**DSC-9.** MUST NOT state a claim without the full URL of its source, and MUST NOT give estimates from memory.
**DSC-10.** Write "not established" always with its cause (403, no domain, robots, JS-rendered page, no public source); gaps are a valid result.
**DSC-11.** Take sources in this order: store page, store API, maker's site, help center, changelog, maker's channels, press release; review sites count only as opinions.
**DSC-12.** Quote verbatim in the original language with author and date (opinions also with the app version), negative ones especially; drop an undated quote, because the product may have changed.
**DSC-13.** Write numbers, not adjectives ("rating 1.5 at n=128"), and count deployments instead of judging them.
**DSC-14.** MUST NOT invent feature, API or limit names: what the maker does not name, you do not name.
**DSC-15.** Read all metrics in one time window recorded in the shared brief, and date every metric.
**DSC-16.** Record absence as "no publicly announced deployment found in a set of N=<n>"; MUST NOT write "does not exist".

### Fetching
**DSC-17.** MUST NOT load raw HTML into an agent's context: download to `research/raw/`, extract fields with a script and analyze only the fields.
**DSC-18.** Record an empty JS-rendered shell or a 403 as a gap with its cause, not as a missing feature; test the URL parser on addresses ending with a parenthesis, because a cut URL gives a false 404.
**DSC-19.** Take store reviews and stars from the store API; without one, verify on a sample that each star rating pairs with its review text.
**DSC-20.** Check register links and images with a script (HTTP status, content type); every result other than 200 has its cause written down.

### Analysis
**DSC-21.** Put controlled pairs first (the strongest evidence): everything fixed except one variable, with what is controlled, what is not, the conclusion it allows and the one it does not.
**DSC-22.** Keep saturation counts (feature, deployments, set, market, need code); flag a zero with the warning that an empty field may come from a legal or platform barrier, not an opportunity.
**DSC-23.** Keep three lists: table stakes (feature + number of independent deployments), differentiators (product + metric + URL), deliberately abandoned (who + quote + URL).
**DSC-24.** Rank solutions with a justified difficulty S (days, plain code), M (ready package), L (native module or partner SDK on the critical path), XL (needs the platform owner's consent) and a wave 1 (MVP), 2 (quarter after) or 3 (later or never).
**DSC-25.** Number "advise against" items `O1…On` continuously across discovery, each with a blocking quote from documentation or law.
**DSC-26.** For every flagship move, record hypotheses on why nobody has done it and how to check that the reason is not a good one.

### Merging and synthesis
**DSC-27.** Build a large stream as blocks in `research/tmp/` (content, register, images, gaps, synthesis) joined by a merge script in a fixed order that backs up its target; MUST NOT edit the merged file by hand.
**DSC-28.** After each block, the merge author adds an independent cross-check (another source or a new query, not the same URL) of every claim a wave, difficulty, scope item or NO depends on: claim, sources, CONFIRMED, REFUTED or REFINED, product consequence.
**DSC-29.** A REFUTED or REFINED cross-check corrects the facts synthesis and the scope it touches; the primary source wins over a summary.
**DSC-30.** A stream's synthesis part ends with a declaration that it introduces no source outside the register.
**DSC-31.** Update `research/facts-synthesis.md` after every stream: numbers per stream, controlled pairs first, "what nobody does" (x of N), findings that change the narrative, decisions to take, caveats, cross-check corrections.
**DSC-32.** Express confidence in words, never as a number; give the sample size, mark a small one as not significant (default n<10), and mark internal numbers that cannot be checked publicly.

### Interviews
**DSC-33.** Keep three layers: transcripts (one file per session) → notes with findings and `[hh:mm:ss]`, grouped by theme → a synthesis built from the notes, not from the transcripts.
**DSC-34.** Interviews give verdicts on the desk-research hypotheses; MUST NOT treat them as a new wish list.
**DSC-35.** Mark each quote and finding S (spontaneous) or P (prompted), and list the moderator's prompts with timestamps under limits.
**DSC-36.** A finding has a thesis, x of N, quotes and "what it means for the product" with a measurable threshold; an MVP item has What · Evidence · Done when (observable criterion) · What not to do.
**DSC-37.** Limits MUST list sessions that did not happen (x of planned), the sample's skew against recruitment and topics never asked ("no data from any method").
**DSC-38.** A repository with transcripts MUST be private; delete recordings after anonymization by the deadline a decision sets, recorded in the synthesis.

### Decision report
**DSC-39.** The report is one self-contained HTML file joined from parts `report/NN-*.part` in name order; an agent edits or generates one part, never the whole.
**DSC-40.** Generate data parts with a script from `report/data/*.json`; MUST NOT rewrite them by hand, and check manual style fixes after each generation.
**DSC-41.** Scope classes: MUST (the first items are often conditions, not features) · NICE (advantage) · LATER (a queue, not a rejection) · NO (each item with a blocking quote, regulation or number).
**DSC-42.** An item card has the need code, a tag (condition, legal duty or x of N), the cost S/M/L and expandable evidence.
**DSC-43.** Risks: a table `Issue | What the data says | Recommendation` (a proposal, not a decision), the gaps that block a decision and three actions that close most of them, with deadlines and the numbers to deliver.
**DSC-44.** The report and every synthesis open with a one-sentence answer and end with "What this research does not prove".
**DSC-45.** The PO decides the scope; record each scope decision as a decision.

### Existing system
**DSC-46.** For a product beside an existing system, map that system (live UI, a full-access account, DOM reading) to `research/information-architecture.md` before fixing the scope.
**DSC-47.** Check research figures on the map against the primary report before publishing (percentages, counts, number of areas studied); a secondary summary is not a source.
**DSC-48.** MUST NOT put numbers on modules nobody studied; no data is not the absence of problems.

### Data world
**DSC-49.** Before the first mockup, fix the data world (`research/data-world.md`): one signed-in person, one day, the same records on every screen, and the on-screen clock as part of the scenario.
**DSC-50.** The data world is the only source of mockup data, fixtures (one world file), the mock backend's mode (scenario and clock reproduce a mockup's state) and test assertions, on every screen and in every test.
**DSC-51.** In a conflict, the world's data beats a number in a mockup; record every accepted difference as a decision.
**DSC-52.** The world only grows (new events of the same day); MUST NOT change existing values.
**DSC-53.** Write state changes within the day explicitly: "before HH:MM X, from HH:MM Y; affects flows a, b, c".
