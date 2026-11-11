"""Read the publication times used by the knowledge base navigation."""
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
import re
import sqlite3

import agency_news
import bank_transactions
import claim_check
import clarity_report
import competitor_news
import facility_projects
import liability_insurance
import naver_ads
import payroll_insurance
import recipient_history
import reputation_watch
import search_visibility
import staff_eval
import support_applications
import website_intake

KST = timezone(timedelta(hours=9))


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def monthly_updates(folder, pattern, dates):
    for path in folder.glob('*.json'):
        if not pattern.fullmatch(path.stem):
            continue
        try:
            yield from dates(read_json(path))
        except (OSError, ValueError, KeyError, TypeError):
            continue


def claim_dates():
    for branch in claim_check.report()['branches']:
        yield branch['checkedAt']
        labor = branch['laborCost']
        yield labor['checkedAt']
        yield labor['amounts']['checkedAt']


def policy_dates():
    for branch in liability_insurance.report()['branches']:
        yield (branch['policy'] or {}).get('updatedAt')
        yield (branch['certificate'] or {}).get('uploadedAt')


def ad_dates():
    for branch in naver_ads.BRANCHES:
        yield naver_ads.report(naver_ads.db_path(branch), summary=True, branch=branch)['updated_at']


def article_dates(feed):
    for item in feed.report(feed.db_path())['items']:
        yield item.get('first_seen_at')
        yield item.get('collected_at')


def reputation_dates():
    for item in reputation_watch.report(reputation_watch.db_path())['items']:
        yield item.get('first_detected')
        yield item.get('assessed_at')


def curated_dates(path, item_key):
    data = read_json(path)
    yield data.get('updated')
    for item in data.get(item_key, []):
        yield item.get('updated')
        yield item.get('collected_date')


def sqlite_dates(path, query):
    if path is None or not path.is_file():
        return
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
        yield from db.execute(query).fetchone()


def visibility_dates():
    # Failed browser captures share the observation table. Count only saved results.
    with search_visibility.connect(search_visibility.db_path()) as db:
        yield db.execute("""SELECT MAX(observed_at) FROM web_search_observations
            WHERE json_extract(payload, '$.status') = 'ready'""").fetchone()[0]
        yield db.execute("SELECT MAX(json_extract(payload, '$.observed_at')) FROM observations").fetchone()[0]


def recent(root, now=None):
    """Return feature IDs and timestamps for today's changes in Korea."""
    now = now or datetime.now(timezone.utc)
    today = now.astimezone(KST).date()
    updated = {}

    def keep(feature, value, *, date_only=False):
        if not isinstance(value, str):
            return
        try:
            at = datetime.fromisoformat(value)
        except ValueError:
            return
        if date_only and re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
            at = at.replace(tzinfo=KST)
        if at.tzinfo is None or at > now or at.astimezone(KST).date() != today:
            return
        if feature not in updated or at > updated[feature]:
            updated[feature] = at

    data = root / 'data'
    try:
        for feature, value in read_json(data / 'card_updates.json').items():
            keep(feature, value)
    except (OSError, ValueError, AttributeError):
        pass

    try:
        operating_at = read_json(data / 'operating_report.json').get('updatedAt')
        keep('operating-costs', operating_at)
        keep('borrowing-status', operating_at)
    except (OSError, ValueError, AttributeError):
        pass

    sources = {
        'payroll-insurance': lambda: monthly_updates(payroll_insurance.root(), payroll_insurance.MONTH,
                                                    lambda report: [report['checkedAt']]),
        'recipient-history': lambda: monthly_updates(recipient_history.root(), recipient_history.MONTH,
                                                    lambda report: (b['checkedAt'] for b in report['branches'])),
        'bank-transactions': lambda: monthly_updates(bank_transactions.root(),
                                                     re.compile(r'20\d{2}-(?:0[1-9]|1[0-2])-(?:anyang|incheon)'),
                                                     lambda report: [report['collectedAt']]),
        'claim-check': claim_dates,
        'liability-insurance': policy_dates,
        'website-requests': lambda: [website_intake.summary()['lastReceivedAt']],
        'naver-ads': ad_dates,
        'clarity-report': lambda: [(clarity_report.report()['latest'] or {}).get('collected')],
        'search-visibility': visibility_dates,
        'competitor-news': lambda: article_dates(competitor_news),
        'agency-news': lambda: article_dates(agency_news),
        'reputation-watch': reputation_dates,
        'trend': lambda: curated_dates(data / 'trend_ideas.json', 'ideas'),
        'support-resources': lambda: curated_dates(data / 'support_resources.json', 'items'),
        'facility-3d': lambda: sqlite_dates(facility_projects.DB_PATH, 'SELECT MAX(updated_at) FROM facility_projects'),
        'staff-eval': lambda: sqlite_dates(staff_eval.db_path(), """
            SELECT MAX(created), MAX(submitted_at), MAX(confirmed_at), MAX(deleted_at) FROM staff_evaluations
        """),
        'support-projects': lambda: sqlite_dates(support_applications.path(), """
            SELECT (SELECT MAX(updated) FROM grant_projects), (SELECT MAX(created) FROM grant_files)
        """),
        'nearby-facilities': lambda: [read_json(data / 'nearby_facilities.json').get('categoryUpdatedAt')],
    }
    for feature, values in sources.items():
        try:
            for value in values():
                keep(feature, value, date_only=feature in ('trend', 'support-resources', 'nearby-facilities'))
        except (OSError, ValueError, KeyError, TypeError, AttributeError, sqlite3.Error):
            continue
    return {feature: at.astimezone(timezone.utc).isoformat() for feature, at in updated.items()}
