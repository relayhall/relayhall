# Dependency picker behavior

The task dependency picker now uses server-backed search instead of loading the full task list and filtering only in the browser.

## Expected search behavior

The picker should return non-archived tasks other than the task currently being edited when the query matches any of:
- task title, exact or fragment
- short task ID, for example `1ad5375c`
- full UUID with hyphens
- full UUID without hyphens
- project name fragment

## UX rules

- Search requests are debounced by 180ms.
- Focusing the input opens the picker immediately.
- Empty query shows a small recent task list to make quick picking easier.
- Selected dependencies stay labeled in the editor even after the search query changes.
- Selected dependencies are excluded from results.
- Results are capped to 10 visible options.
- Empty states differentiate between loading recent tasks, search failure, and no matches.

## API contract

`GET /api/tasks` supports these dependency-search query params:
- `q`: search string
- `excludeTaskId`: omit the task being edited
- `limit`: cap returned rows, max 100

Search matching is case-insensitive and also checks a hyphen-stripped version of task UUIDs so pasted compact IDs still resolve.
