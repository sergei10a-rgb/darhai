---
guideVersion: 2.0.0
estimatedMinutes: 2
steps:
  - id: install
    title: Install the MCP server
    estSeconds: 30
    autoCompletedByInstall: true
    body: |
      Дархай bundles the Cal.com server as `builtin-mcp-cal-com.js` - nothing
      to download.

      It is **read-only**. Дархай can show you your bookings, your event types
      and your free slots, and it can draft a booking for you to confirm. It
      never books, cancels or reschedules anything by itself.
  - id: apikey
    title: Paste your Cal.com API key
    estSeconds: 60
    inputs:
      - { name: CALCOM_API_KEY, label: 'Cal.com API key', secret: true }
      - { name: CALCOM_BASE_URL, label: 'Self-hosted base URL (leave blank for cal.com)' }
    body: |
      1. Open <https://app.cal.com/settings/developer/api-keys>.
      2. Press **Add** and give the key a name such as `Darhai`.
      3. Copy the key and paste it above. It starts with `cal_live_`.

      Leave the second field blank unless you run your own Cal.com. If you do,
      a bare hostname such as `cal.example.com` is enough - Дархай adds
      `https://` and `/v2` for you.

      The key stays on this machine. No tool returns it and every error message
      is scrubbed before it is shown, so it cannot leak through a failure.

      Ask "who am I on Cal.com?" once you have saved it - that runs
      `cal_whoami` and confirms the key works.
---

# Cal.com Scheduling - read-only

## What you get

| Tool                      | What it does                                                        |
| ------------------------- | ------------------------------------------------------------------- |
| `cal_whoami`              | Which Cal.com account the key belongs to - the fastest setup check   |
| `cal_list_bookings`       | Upcoming, past, cancelled or all bookings, with attendees            |
| `cal_get_booking`         | One booking by uid, including its cancel and reschedule links        |
| `cal_list_event_types`    | Your bookable event types and their public links                     |
| `cal_get_available_slots` | Free slots for an event type over a date range                       |
| `cal_draft_booking`       | Checks a time is genuinely free and composes a booking **you** confirm |

## Why there is no "book it for me" tool

A Cal.com booking is someone else's time. A booking or a cancellation you did
not approve sends mail to the other person immediately, and that mail cannot be
un-sent. Cal.com API keys are account-wide, so a tool that could cancel one
meeting could cancel every meeting.

So Дархай stops one step short. `cal_draft_booking` does the part a model is
actually good at - checking the slot is free, filling in the details, offering
alternatives when the time you asked for is taken - and then hands you the
Cal.com link. You click once. Nothing reaches the other person until you do.

## Self-hosted Cal.com

Set `CALCOM_BASE_URL`. Дархай sends the per-route `cal-api-version` headers the
v2 API requires (`2024-08-13` for bookings, `2024-06-14` for `/me` and event
types, `2024-09-04` for slots), so an older self-hosted build may answer 404 for
routes it does not serve yet - the error message says so explicitly rather than
leaving you guessing.
