# 주변 영업처 지도

`/nearby-facilities.html` shows the public facility research dataset around the two The Vida branches. The homepage links to this page. Kakao Maps displays markers, clusters and the selected 1/3/5 km radius. The list supports branch, facility type, text and explicitly listed bathing-service filters. CSV exports only the filtered public records.

Set `KAKAO_JAVASCRIPT_KEY` in the Railway `competitors` service, `dev` environment. The key must have `https://competitors-dev.up.railway.app` registered as a JavaScript SDK domain, and Kakao Maps must be enabled. For local live-map testing, register the specific localhost origin separately. This key is intentionally sent to the browser by `/api/maps-config`. No REST API key or admin key is needed for displaying this dataset.

`/api/nearby-facilities` serves `data/nearby_facilities.json`. Source URLs, coordinate provenance and service caveats are preserved per facility. The September 8, 2026 snapshot contains 450 Anyang and 362 Incheon candidates, primarily from municipal lists plus seven hospitals. It is not an exhaustive or verified-open business directory. Incheon bathing-service coverage is incomplete. Kakao search results are not collected or persisted. No API keys are included in the dataset or committed source.

The September 9 category update adds 87 nursing-home records from that same source snapshot and reclassifies the existing Anyang Senior Nursing Home record, bringing the `요양원` category to 39 Anyang and 49 Incheon records. The category includes elderly nursing facilities and elderly nursing group homes, excluding child, disability and mental-health group homes. Incheon entries are classified by their municipal listing names; their exact facility subtype needs confirmation. The separately listed attached day-care center retains its `주야간보호` category. The two reference branches and their same-address predecessor listings are excluded. `categoryUpdatedAt` records the classification update separately from the source snapshot date `asOf`.

Update the public dataset with a new `asOf` and reviewed records when refreshing research. Stable IDs derive from branch, name and address. Map load failures leave the list, source links and CSV available.

Checks: `python -m unittest test_nearby_facilities test_static_pages test_site_identity`; `node --test test_nearby_facilities.cjs`; browser check on the registered production origin for SDK authorization and map tiles.
