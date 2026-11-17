---
"@dudousxd/nestjs-agent-dashboard": minor
---

Console filters now live in the URL, so a filtered view can be shared, bookmarked and reloaded, and Back/Forward step through it: the day range (kept across pages), the chart metric on Spend and Generative UI, the Reliability runs table's status, agent, thread and page, the Runs & tools tables' filters and pages, and the Approvals page. They sit in the hash's query (`#/reliability?status=failed&agent=support`), read and written with nuqs through the console kit's hash adapter; a value at its default is left out, so existing `#/<page>` and `?threadId=` links open as before.
