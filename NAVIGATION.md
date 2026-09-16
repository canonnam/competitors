# Knowledge base navigation

`assets/navigation.js` enhances the existing pages without changing tool APIs or authentication. `assets/navigation.css` scopes the shared layout under `kb-navigable`.

- The `features` directory maps every home card to its route, category, concise description and search aliases. Add a matching entry when adding a home card. The directory is checked against the home links by `node --test test_navigation.cjs`.
- Desktop pages share a category sidebar. Every internal page exposes a native “기능 찾기” dialog, also available with Ctrl/Cmd+K. Home category and search state survive a return through the URL.
- Favorites (including manually edited order) and the card/list preference are stored under `vida-navigation-v1` in this browser's localStorage. Layout version 2 defaults to the list, preserves existing favorites, and removes legacy recent-use history. Subsequent user selections of card view are remembered. These are device-local preferences; blocked storage falls back to in-memory state.
- Home cards retain their live status DOM nodes and IDs. Existing news, claim, advertising and monitoring collectors continue updating them; concise summaries keep every card the same height. Filtering does not acknowledge unread news.
- `assets/news-badge.js` shares unread counts with category menus and feature search. Cached article IDs persist across navigation; detail pages fetch other feeds' summaries without marking them read. Only successfully displayed feed pages acknowledge their own articles. Fixed-size N badges do not shrink in mobile layouts.
- Seven transparent paper-clay icons live in `assets/icons/clay/`; their generation prompts are recorded in `asset-prompts.md` there. The favorites control uses the clay tag, with distinct selected and unselected appearances.
- `support-share.html` is intentionally excluded from internal navigation. Its expiring, scoped external share flow remains unchanged.

Validation: navigation/storage/search and unread-feed tests; all 17 internal pages mounted against their actual HTML with live status node identity preserved; browser checks at 320px and 390px mobile widths and desktop card view, including equal heights, intact N badges, and unread menu counts clearing after reading a feed. The existing metadata suite already fails for missing `og:url` on `support-projects.html` and `support-share.html`; navigation does not modify their sharing metadata.
