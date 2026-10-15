import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ALT_MAX,
  ALT_NONE,
  altEditChange,
  fixRequest,
  reasonText,
  ruleLabel,
  thumbUrl,
  type AltImage,
  type ClassStats,
  type FixStatus,
  type Patch,
} from '../../../lib/fixes-api';
import { suggestAt } from './FixesTab';
import { AltCount } from './FieldDiff';
import { ALT_EDIT_HINT, PatchCard, type CardPanel } from './PatchCard';

// Neutral fixtures only: this repo is public. Invented ids and example.test URLs.
function patch(id: string, status: FixStatus, over: Partial<Patch> = {}): Patch {
  return {
    id,
    patch_sha256: id.padEnd(64, '0'),
    store: 'alpha',
    product_id: '1001',
    product_title: `Sample Item ${id.slice(-2)}`,
    admin_url: 'https://admin.example.test/products/1001',
    fix_class: { store: 'alpha', rule: '4', field: 'descriptionHtml' },
    addresses: { finding_ids: ['f-1'], rec_ids: [] },
    changes: [{ field: 'descriptionHtml', before: '<p>Old text.</p>', before_sha256: 'b'.repeat(64), after: '<p>New text.</p>' }],
    validator: { passed: true, checks: [{ name: 'specs', passed: true }] },
    judge: { verdict: 'clear' },
    status,
    edited: false,
    created_at: '2026-10-15T06:00:00Z',
    decided_at: null,
    note: null,
    history: [{ status: 'proposed', at: '2026-10-15T06:00:00Z' }],
    applied: null,
    verified: null,
    ...over,
  };
}

const IMAGES: AltImage[] = [
  { media_id: 'gid://shopify/MediaImage/11', url: 'https://cdn.example.test/files/a.jpg?v=1', before: '', after: 'Sample widget, front view' },
  { media_id: 'gid://shopify/MediaImage/12', url: 'https://cdn.example.test/files/b.jpg', before: '', after: 'Sample widget <b>side</b> view' },
];

const altMap = (imgs: AltImage[], key: 'before' | 'after') =>
  JSON.stringify(Object.fromEntries(imgs.map((i) => [i.media_id, i[key]])));

/** An alt patch as Hermes sends it (A17): one change holding the alt map as
 * JSON, and the images it writes. */
function altPatch(id: string, status: FixStatus, over: Partial<Patch> = {}): Patch {
  return patch(id, status, {
    fix_class: { store: 'alpha', rule: 'seo:image_alt', field: 'image.alt' },
    source: 'seo',
    checks_profile: 'alt',
    copy_source: { generated_at: '2026-10-15T05:00:00Z', source_commit: 'abc1234' },
    addresses: { finding_ids: [], rec_ids: [], seo_issues: ['product_images_missing_alt'] },
    changes: [{ field: 'image.alt', before: altMap(IMAGES, 'before'), before_sha256: 'b'.repeat(64), after: altMap(IMAGES, 'after') }],
    images: IMAGES,
    validator: { passed: true, checks: [{ name: 'length', passed: true }, { name: 'html', passed: true }] },
    ...over,
  });
}

function card(p: Patch, panel: CardPanel = null) {
  return renderToStaticMarkup(
    <PatchCard
      patch={p}
      storeName="Alpha"
      focused={false}
      panel={panel}
      onPanel={() => {}}
      onFocus={() => {}}
      onDecide={() => {}}
      recTitles={{}}
    />,
  );
}

describe('image alt patches (0011 A17)', () => {
  it('renders one row per image: a small lazy thumbnail and the alt before and after', () => {
    const html = card(altPatch('a1', 'proposed'));
    expect(html).toContain('data-alt-images="2"');
    expect(html).toContain('data-media-id="gid://shopify/MediaImage/11"');
    expect(html).toContain('src="https://cdn.example.test/files/a.jpg?v=1&amp;width=160"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('Sample widget, front view');
    // the alt map's JSON is not shown
    expect(html).not.toContain('MediaImage/11&quot;:');
    expect(html).not.toContain('data-diff=');
  });

  it('shows the alt as plain text, never markup', () => {
    const html = card(altPatch('a2', 'proposed'));
    expect(html).toContain('Sample widget &lt;b&gt;side&lt;/b&gt; view');
    expect(html).not.toContain('<b>side</b>');
  });

  it('shows an empty before as “— none —”', () => {
    const html = card(altPatch('a3', 'proposed'));
    expect(html.split(ALT_NONE).length - 1).toBe(2);
    const filled = card(altPatch('a4', 'proposed', { images: [{ ...IMAGES[0], before: 'Old alt' }] }));
    expect(filled).toContain('Old alt');
    expect(filled).not.toContain(ALT_NONE);
  });

  it('reads “Image alt” on the class chip and in the class panel', () => {
    expect(ruleLabel('seo:image_alt')).toBe('Image alt');
    expect(ruleLabel('4')).toBe('rule 4');
    expect(ruleLabel('seo:foundry')).toBe('seo:foundry');
    const html = card(altPatch('a5', 'proposed'));
    expect(html).toContain('data-rule="seo:image_alt"');
    expect(html).toContain('>Image alt<');
    expect(html).toContain('checks: alt');
    expect(html).toContain('images missing alt text');
  });

  it('suggests auto-apply at 10, from the feed or by rule', () => {
    const c = (over: Partial<ClassStats>): ClassStats => ({
      store: 'alpha', rule: 'seo:image_alt', field: 'image.alt',
      streak: 0, approvals: 0, edits: 0, rejects: 0, reverts: 0, tier: 0, eligible: false, ...over,
    });
    expect(suggestAt(c({ suggest_at: 10 }))).toBe(10);
    expect(suggestAt(c({}))).toBe(10);
  });

  it('a thumbnail only for an https URL', () => {
    expect(thumbUrl('https://cdn.example.test/x.png?width=2048')).toBe('https://cdn.example.test/x.png?width=160');
    expect(thumbUrl('http://cdn.example.test/x.png')).toBeNull();
    expect(thumbUrl('javascript:alert(1)')).toBeNull();
    expect(thumbUrl('not a url')).toBeNull();
  });

  it('shows the writer’s outcome codes in words', () => {
    expect(reasonText('media_not_on_product')).toBe('an image is no longer on this product');
    expect(reasonText('revert_blocked')).toBe('the revert was blocked');
    const html = card(
      altPatch('a6', 'proposed', {
        history: [
          { status: 'approved', at: '2026-10-15T07:00:00Z' },
          { status: 'refused', at: '2026-10-15T07:02:00Z', reason: 'media_not_on_product' },
        ],
      }),
    );
    expect(html).toContain('Why proposed: an image is no longer on this product');
    const reverted = card(
      altPatch('a7', 'applied', {
        history: [
          { status: 'applied', at: '2026-10-15T07:00:00Z' },
          { status: 'revert_blocked', at: '2026-10-15T08:00:00Z', reason: 'revert_blocked', note: 'an image alt changed since the write' },
        ],
      }),
    );
    expect(reverted).toContain('Why applied: the revert was blocked');
  });
});

describe('editing an alt patch (A17)', () => {
  it('the editor has one field per image with a count against 125', () => {
    const html = card(altPatch('e1', 'proposed'), 'edit');
    expect(html).toContain('data-alt-editor');
    expect(html.match(/<textarea/g)).toHaveLength(2);
    expect(html).toContain(`data-chars="${'Sample widget, front view'.length}"`);
    expect(html).toContain(`/ ${ALT_MAX}`);
    expect(html).toContain(ALT_EDIT_HINT);
    // nothing changed yet: Save is off
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Nothing changed: use Approve"/);
  });

  it('the count flags an alt over the limit, and an empty one', () => {
    const long = renderToStaticMarkup(<AltCount text={'x'.repeat(126)} />);
    expect(long).toContain('data-chars="126"');
    expect(long).toContain('data-chars-off="long"');
    expect(long).toContain('too long');
    const ok = renderToStaticMarkup(<AltCount text={'x'.repeat(125)} />);
    expect(ok).not.toContain('data-chars-off');
    const empty = renderToStaticMarkup(<AltCount text="" />);
    expect(empty).toContain('data-chars-off="empty"');
    // counts code points, as Hermes does
    expect(renderToStaticMarkup(<AltCount text="café 🙂" />)).toContain('data-chars="6"');
  });

  it('an edit sends only the changed images, keyed by media_id', () => {
    const drafts = { [IMAGES[0].media_id]: IMAGES[0].after, [IMAGES[1].media_id]: 'Sample widget, side view' };
    const change = altEditChange(IMAGES, drafts);
    expect(change).toEqual({
      field: 'image.alt',
      images: [{ media_id: 'gid://shopify/MediaImage/12', after: 'Sample widget, side view' }],
    });
    expect(altEditChange(IMAGES, Object.fromEntries(IMAGES.map((i) => [i.media_id, i.after])))).toBeNull();
    const req = fixRequest('edit', altPatch('e2', 'proposed'), { changes: [change!] });
    expect(req).toEqual({
      path: '/api/commerce/fixes/e2/edit',
      body: { patch_sha256: 'e2'.padEnd(64, '0'), changes: [change] },
    });
  });
});

describe('older and unknown shapes stay harmless', () => {
  it('a copy patch is unchanged: its diff, its editor, no alt rows', () => {
    const html = card(patch('o1', 'proposed'));
    expect(html).toContain('data-diff=');
    expect(html).not.toContain('data-alt-images');
    expect(html).not.toContain('data-rule=');
    const editor = card(patch('o2', 'proposed'), 'edit');
    expect(editor).not.toContain('data-alt-editor');
    expect(editor).toContain('Save edit and approve');
  });

  it('an unknown field renders as a plain diff', () => {
    const html = card(
      patch('u1', 'proposed', {
        fix_class: { store: 'alpha', rule: 'seo:future', field: 'media.caption' },
        changes: [{ field: 'media.caption', before: '', before_sha256: 'b'.repeat(64), after: '<i>New</i>' }],
      }),
    );
    expect(html).toContain('media.caption');
    expect(html).toContain('&lt;i&gt;New&lt;/i&gt;');
    expect(html).not.toContain('<i>New</i>');
  });

  it('an image.alt change without images falls back to the plain diff', () => {
    const html = card(altPatch('u2', 'proposed', { images: undefined }));
    expect(html).not.toContain('data-alt-images');
    expect(html).toContain('data-diff=');
  });
});
