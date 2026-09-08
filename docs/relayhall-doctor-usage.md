# RelayHall doctor

`relayhall doctor` runs a board-integrity audit from the canonical RelayHall CLI. It reads tasks, projects, personalities, and model status through the RelayHall API using GET requests only — it never mutates board state.

## Usage

```bash
relayhall doctor                         # human-readable report
relayhall doctor --json                  # machine-readable report
relayhall doctor --discord-summary       # compact summary for Discord
relayhall doctor --deliver hermes-discord            # deliver summary via `hermes send`
relayhall doctor --deliver hermes-discord --dry-run  # preview delivery
relayhall doctor --post-discord --discord-webhook URL  # deliver via raw Discord webhook
relayhall doctor --install-cron          # install weekly user cron (Mondays 08:00)
relayhall doctor --install-cron --dry-run
```

## Delivery

The default output is stdout only. `--deliver hermes-discord` sends the compact
summary through the LLM-free `hermes send` CLI as the Hermes OS user
(`sudo -n -u <hermes-user> hermes send --to TARGET`).
The target uses the hermes target format
`platform:chat_id` (e.g. `discord:<channel-id>`) and can be set with
`--deliver-target` or `RELAYHALL_DOCTOR_DELIVER_TARGET`. Cross-account delivery
requires an explicitly configured, narrowly scoped passwordless sudo rule for the
invoking service account; it needs no webhook secret or running gateway.

Webhook posting alternatively uses `--discord-webhook` or
`RELAYHALL_DOCTOR_DISCORD_WEBHOOK_URL` / `RELAYHALL_DOCTOR_DISCORD_WEBHOOK` at runtime.
Do not commit webhook URLs.

The installed cron runs Mondays at 08:00 and appends logs to `/tmp/relayhall-doctor.log`.
`scripts/relayhall-doctor-weekly.sh` is an equivalent wrapper that normalizes doctor
exit code 2 (findings present) to 0 for scheduler use.

## Checks

The check registry currently detects:

1. `dangling-depends-on` — active task depends on a missing task ID.
2. `archived-depends-on` — active task depends on an archived task.
3. `stale-blocked-flags` — task has blocked metadata after blockers/dependencies are gone.
4. `duplicate-project-names` — non-archived projects share a normalized name.
5. `duplicate-personality-names` — personalities share a normalized name.
6. `duplicate-personality-slugs` — personalities share a normalized slug.
7. `missing-dod` — active task lacks `definitionOfDone` and `successCriteria`.
8. `autostart-outside-todo` — `autoStart=true` on a task outside `todo`.
9. `task-without-project` — active task has no project or references an unknown project.
10. `unavailable-model-pin` — task model pin is absent from `/models/available`.

Exit code is `2` when error-severity issues are found, `1` for command/delivery failures, and `0` otherwise.
