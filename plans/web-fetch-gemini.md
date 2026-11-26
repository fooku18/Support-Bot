# Web fetch through a Gemini page reader

Status: Human review

## Summary

`web_fetch` needed a separate isolated web service that this repository does
not ship. Claude on Vertex offers no fetch tool, so the answering model cannot
fetch either. Gemini's URL context tool retrieves the page at Google.

## Decisions and approach

- `web_fetch(url, question)` asks a Gemini Flash model one question about one
  page. Word-for-word transcription was tried first and rejected: about 50 s per
  page, recitation stops, cut output.
- A result counts only when the API's retrieval metadata reports success for
  the requested host and for every retrieved URL. The model's text alone is
  never enough. The result names the retrieved URLs and says that only quoted
  passages are the page's own words.
- The process refuses non-HTTP(S) URLs, credentials, other ports, IP literals,
  undotted names and private suffixes before any request.
- Fixed instructions treat the page as untrusted data. Error messages are fixed
  and carry no upstream text.
- The answering model stays unchanged. The reader has its own key and endpoint,
  which only the agent receives; the tool runtime refuses to start with the key.
- The isolated web runtime stays as the alternative for exact page content.
- Tradeoffs: the URL and question go to Google. A prompt-injected answer could
  put conversation data into a URL, as with any fetch tool; the tool
  description forbids it, nothing enforces it. Reader cost is not in the ledger.

## Work

- [x] Reader, configuration, binding, tool contract
- [x] Tests and documentation

## Verification

- Deterministic: see the pull request.
- Reader against a LiteLLM gateway with `gemini-3.5-flash`, 2026-11-25: 8 of 8
  reachable public pages answered in 2.5 to 3.5 s (RFC, Wikipedia, Node.js docs,
  GitHub, a shop page, a redirect, an absent fact reported as NOT_ON_PAGE, and a
  page with an injected instruction, which was reported and not followed). A 404
  page, a metadata address and an internal service name were refused.
- Live: **Blocked**. T4 and T5 need the designated test instance.

## Rollout

Set `NATIVE_WEB_FETCH_MODEL`, `NATIVE_WEB_FETCH_API_KEY` and, for a gateway,
`NATIVE_WEB_FETCH_BASE_URL` on the agent. Remove them to turn it off.

## Open items

- [ ] Pass the settings through Compose and the egress proxy
- [ ] Reader requests in the cost ledger
- [ ] T3 `application` on a Linux Docker host, T5 on the test instance
