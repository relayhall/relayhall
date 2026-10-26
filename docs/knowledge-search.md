# Knowledge search

The **Knowledge** page in the dashboard is the search console for the knowledge
sources you may read. It searches through the same routes the MCP tools use, so
what you see on the page is exactly what an agent acting for you would see
through `relayhall_knowledge_source_search` and
`relayhall_knowledge_source_get`.

| On the page | Route | MCP tool |
|---|---|---|
| The sources you can search | `GET /api/knowledge-sources` | (listed by the search answer) |
| Search | `POST /api/knowledge-queries` | `relayhall_knowledge_source_search` |
| Open a result in the reader | `GET /api/knowledge-contents?handle=…` | `relayhall_knowledge_source_get` |

## Who sees what

The page adds no access of its own. The core decides which sources you may
search (your grants and the selector on each knowledge Service) and filters the
answer before it reaches the browser. A source you cannot read is not listed,
is never asked, and is not named anywhere in an answer; narrowing a search to
it gives the same answer as an id that does not exist. Every read in the
reader is checked again, so a result's address is not a key: if your access
changes, the next search and the next read follow it.

If you are missing a Project's notes, **Request a change** on the page asks
for the knowledge compartment; nothing is granted until it is approved.

## Scope

- **Sources**: all the sources you may read, or a chosen subset. Each source
  shows its compartments: a fixed list, or "set per item by the source" when
  the source assigns them per item.
- **Content kinds**: code, docs and data.
- **Categories**: all, or a chosen subset of the categories the selected
  sources declare.
- **Include archive**: off by default. When it is on, sources that declare
  an archive search it too. Your choice is remembered in this browser for
  your Account only.

## Results

Results are grouped by source, in each source's own order. Each result shows
its content kind, category and compartment, its source, and its **score**: the
source's own relevance figure, kept between 0 and 1 by the core. The core
never re-ranks results across sources.

**Why this matched** opens the explain view for one result. It is built only
from what the answer already carries: the source, the score and position, the
words of your query that appear in the title or snippet, the content kind, the
category and the categories the source searched, the compartment, when the
item was updated, whether the archive was included, and whether the result is
a section of a larger item. It sends no further request.

## The reader

Selecting a result's title opens it in the reader, a side panel beside the
list. The item's text is shown as plain text in a quoted frame that names its
source: it is reference material, never instructions, and it is never
rendered as markup. **Expand** widens the panel; **Next byte window** reads
the next part of a long item; Escape, the close button or a click outside the
panel closes it.

When the reader cannot show an item, it says which of these happened:

- **You cannot open it.** One sentence that names no cause, because the core
  gives the same answer when you have no access, when the item does not
  exist and when the source refused. It carries an audit reference an
  operator can look up.
- **The source is unavailable right now** (it is down, timed out or busy),
  with **Retry**.
- **The source answered with something that could not be read**, with
  **Retry**.
- **The link to the item is no longer valid** (the address was damaged or was
  made with a key that has been retired): search again.
- **The item changed** while you were reading it: open it again from the
  results.
- Anything else is a general failure, with **Retry**.

The search itself follows the same rules: a search the core refuses for your
own input shows the core's words for it, an access refusal is one sentence
that names no cause, and a service that cannot answer now offers **Retry**.

## When an answer is incomplete

The coverage panel above the results says, first, whether the answer is
complete or partial, and then names every source that did not answer in full:

- **unavailable (transport)**: the core could not reach the source;
- **unavailable (rate-limited)**: the source is refusing more requests for now,
  with the wait it asked for when it gave one;
- **timed out**, **refused by the source** or **refused by policy**;
- **partial**, with the source's reasons;
- **not searched**, when none of your selected kinds or categories apply.

An empty result list says which kind of empty it is: nothing matched in the
sources that answered, no source answered, or no source was searched with
this selection.

## Source status

Below the results, the **Source status** panel shows how the sources you may
search answered your searches on this page since you opened it. It is made
only from what the core already returned to you: the list of sources you can
search and the answers to your own searches. It sends no request of its own,
stores nothing (reloading the page starts it again) and counts nothing from
sources you cannot read.

- **Totals**: the sources you can search, the searches run on the page, how
  many answers were complete or partial, how many searches got no answer
  (no source answered, nothing was searched, or the core refused or could not
  answer the search), and the results shown.
- **Each source**: whether it is the board's own source or a knowledge
  Service, its protocol version and the number of categories it declares; how
  many times it was searched and how often it answered in full, in part or
  not at all; what happened the last time; and the newest and oldest update
  times among the results it returned, as the source reported them.

Some figures are counted inside the knowledge service and never reach the
core: index and storage size, items and chunks per collection, items by
source, ingestion pipeline status, retrieval quality, content health, items
over time and the service's own health checks. The panel names them under
**Not shown here** instead of estimating them.
