# Knowledge base navigation

`assets/navigation.js` enhances the existing pages without changing tool APIs or authentication. `assets/navigation.css` scopes the shared layout under `kb-navigable`.

- The `features` directory maps every home card to its route, category, concise description and search aliases. Add a matching entry when adding a home card. The directory is checked against the home links by `node --test test_navigation.cjs`.
- Desktop pages share a category sidebar. Every internal page exposes a native “기능 찾기” dialog, also available with Ctrl/Cmd+K. Home category and search state survive a return through the URL.
- Favorites (including manually edited order), three recent feature IDs and the card/list preference are stored under `vida-navigation-v1` in this browser's localStorage. They are not account settings and do not sync across devices. No form contents, record IDs, queries, tokens or personal data are stored in these preferences. Blocked storage falls back to in-memory state.
- Home cards retain their live status DOM nodes and IDs. Existing news, claim, advertising and monitoring collectors continue updating them. Filtering does not acknowledge unread news.
- `support-share.html` is intentionally excluded from internal navigation. Its expiring, scoped external share flow remains unchanged.

Validation for this change: navigation/storage/search tests, all 17 internal pages mounted against their actual HTML, live status node identity preservation, and existing static route/feedback/auth checks. The existing metadata suite already fails for missing `og:url` on `support-projects.html` and `support-share.html`; navigation does not modify their sharing metadata.
