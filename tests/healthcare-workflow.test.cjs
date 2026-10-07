const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

const root = path.resolve(__dirname, '..');
const workflow = JSON.parse(fs.readFileSync(path.join(root,
  'SRLINES Pakistan Healthcare AI Lead Intelligence - WhatsApp-Meta CRM.json')));
const nodes = Object.fromEntries(workflow.nodes.map(n => [n.name, n]));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const cities = ['Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Peshawar', 'Quetta'];

async function run(name, rows = [], options = {}) {
  const items = rows.map(json => ({json}));
  const fn = new AsyncFunction('$input', '$', '$getWorkflowStaticData', '$env', nodes[name].parameters.jsCode);
  return fn.call({helpers: {httpRequest: options.http || (async () => {throw Error('Unexpected HTTP request');})}},
    {all: () => items, first: () => items[0]},
    () => ({first: () => ({json: options.config || {cities: cities.map(city => ({city})), limits: {}, deepseek: {}}})}),
    () => options.state || {}, options.env || {});
}

async function config() {return (await run('Pakistan Runtime Config'))[0].json;}
function lead(overrides = {}) {
  return {businessName: 'Example Hospital', city: 'Karachi', province: 'Sindh',
    address: 'Block A, Karachi, Sindh', website: 'https://example.invalid/',
    domain: 'example.invalid', rawCategory: 'Hospital', providerType: 'hospital',
    healthcareScope: {cityVerified: true, providerType: 'hospital'},
    keyword: 'hospital in Karachi, Pakistan', sourceRetrievedAt: '2026-10-07T00:00:00Z',
    phone: '+922112345678', emails: [], contacts: [], reviews: 0, rating: 0,
    socialProfiles: {facebook: [], instagram: [], linkedin: []}, socialPlatformCount: 0,
    whatsappSignals: {hasClickToChat: false, phoneType: 'landline', numbers: []},
    websiteText: '', websiteSignals: {}, ...overrides};
}
function parametersFor(json) {
  const expression = nodes['Upsert Lead and Decision Makers'].parameters.options.queryReplacement;
  return new Function('$json', `return (${expression.slice(3, -2)});`)(json);
}

test('import metadata, manual entry point and connection targets are valid', () => {
  assert.match(workflow.name, /Healthcare/);
  assert.equal(workflow.active, false);
  assert.equal(new Set(workflow.nodes.map(n => n.id)).size, workflow.nodes.length);
  assert.equal(nodes['Manual Healthcare Run'].type, 'n8n-nodes-base.manualTrigger');
  assert.equal(workflow.connections['Manual Healthcare Run'].main[0][0].node, 'Pakistan Runtime Config');
  for (const [source, outputs] of Object.entries(workflow.connections)) {
    assert.ok(nodes[source], source);
    for (const branch of outputs.main) for (const edge of branch) assert.ok(nodes[edge.node], edge.node);
  }
  for (const node of workflow.nodes) if (node.parameters.jsCode) new AsyncFunction(node.parameters.jsCode);
});

test('runtime restricts discovery to the eight configured cities and healthcare categories', async () => {
  const cfg = await config();
  assert.deepEqual(cfg.cities.map(c => c.city), cities);
  assert.equal(cfg.niche, 'Doctors, Clinics and Hospitals');
  assert.deepEqual(cfg.keywords, ['doctor', 'general physician', 'specialist doctor', 'medical clinic',
    'dental clinic', 'hospital', 'private hospital', 'medical center']);
  assert.equal(cfg.deepseek.apiKey, '');
  assert.match(cfg.executionId, /^pk-healthcare-/);
  assert.equal(cfg.limits.crawlPagesPerSite, 4);
  const injected = await run('Pakistan Runtime Config', [], {env: {DEEPSEEK_API_KEY: 'fixture-key'}});
  assert.equal(injected[0].json.deepseek.apiKey, 'fixture-key');
});

test('rotation covers every city/category exactly once before wrapping', async () => {
  const cfg = await config(); const state = {}; const seen = new Set();
  for (let i = 0; i < 16; i++) {
    const batch = await run('Rotate City and Keywords', [cfg], {state});
    assert.equal(batch.length, 4);
    for (const item of batch) {
      assert.equal(seen.has(item.json.keyword), false);
      seen.add(item.json.keyword);
      assert.ok(cities.includes(item.json.city));
      assert.match(item.json.keyword, /, Pakistan$/);
    }
  }
  assert.equal(seen.size, 64); assert.equal(state.searchRotationCursor, 0);
  const reset = await run('Rotate City and Keywords', [cfg], {state: {searchRotationCursor: 100000}});
  assert.equal(reset[0].json.rotation.index, 0);
});

async function scrape(places, overrides = {}) {
  const cfg = await config();
  return run('Google Maps Pakistan Scraper', [{...cfg, city: 'Karachi', province: 'Sindh',
    category: 'hospital', keyword: 'hospital in Karachi, Pakistan', ...overrides}], {
    http: async request => {
      assert.equal(request.url, 'http://localhost:3000/api/scrape/search');
      assert.equal(request.body.maxResults, 12);
      return {body: {success: true, data: {results: places}}};
    }
  });
}
function place(overrides = {}) {
  return {title: 'Example Hospital', category: 'Hospital', address: 'Block A, Karachi, Sindh',
    website: 'https://example.invalid/', phone: '+92 21 12345678', ...overrides};
}

test('Maps accepts doctors, clinics and hospitals with verified city addresses', async () => {
  const rows = await scrape([place(),
    place({title: 'Example Dental Clinic', category: 'Dental clinic', address: 'Block B, Karachi City 75500, Sindh'}),
    place({title: 'Dr Example', category: 'General physician', address: 'Block C, Karachi District, Sindh'})]);
  assert.deepEqual(rows.map(r => r.json.providerType), ['hospital', 'clinic', 'doctor']);
  for (const row of rows) assert.equal(row.json.healthcareScope.cityVerified, true);
});

test('Maps rejects out-of-city, road-name, missing-address and unrelated listings', async () => {
  const rows = await scrape([
    place({address: 'Block A, Hyderabad, Sindh'}),
    place({address: 'Karachi Road, Hyderabad, Sindh'}),
    place({address: ''}),
    place({title: 'Example Property Consultant', category: 'Real estate agency'})
  ]);
  assert.equal(rows.length, 1); assert.equal(rows[0].json._skipUpsert, true);
  assert.equal(rows[0].json.rejectedOutsideCity, 3);
  assert.equal(rows[0].json.rejectedNonHealthcare, 1);
});

test('Maps keeps the website requirement and emits a continuation item for empty results', async () => {
  const rejected = await scrape([place({website: ''})]);
  assert.equal(rejected[0].json._skipUpsert, true);
  assert.equal(rejected[0].json.rejectedNoWebsite, 1);
  const empty = await scrape([]);
  assert.equal(empty.length, 1); assert.equal(empty[0].json.skipReason, 'google_maps_no_results');
});

test('enrichment captures healthcare evidence and attempts relevant provider pages', async () => {
  const requests = [];
  const rows = await run('Public Website Contact Enrichment', [lead({limits: {crawlPagesPerSite: 4}})], {
    http: async request => {
      requests.push(request.url);
      return '<html><body>Book an appointment. OPD. Online consultation. 24/7 emergency.</body></html>';
    }
  });
  assert.deepEqual(requests, ['https://example.invalid/', 'https://example.invalid/contact',
    'https://example.invalid/doctors', 'https://example.invalid/about']);
  assert.equal(rows[0].json._skipUpsert, false);
  assert.deepEqual(rows[0].json.websiteSignals.healthcare, {providerType: 'hospital', cityVerified: true,
    hasAppointmentEvidence: true, hasTeleconsultationEvidence: true, hasEmergencyEvidence: true});
});

test('unreachable websites retain valid Maps providers; scope skips are preserved', async () => {
  const rows = await run('Public Website Contact Enrichment', [lead()], {http: async () => {throw Error('fixture unavailable');}});
  assert.equal(rows[0].json._skipUpsert, false);
  assert.equal(rows[0].json.websiteSignals.websiteReachable, false);
  const skip = await run('Public Website Contact Enrichment', [lead({_skipUpsert: true, skipReason: 'out_of_scope'})]);
  assert.equal(skip[0].json._skipUpsert, true);
});

test('missing AI credentials use heuristic qualification without sending an API request', async () => {
  const rows = await run('AI Qualify, Score and Nurture', [lead({websiteText: 'Clinic appointment reception'})]);
  assert.match(rows[0].json.aiAnalysis.error, /key is not configured/);
  assert.match(rows[0].json.nurtureStrategy, /hospital administrator/);
  assert.equal(rows[0].json.whatsappCapable, false);
  assert.deepEqual(rows[0].json.contacts, []);
});

test('AI request is healthcare-specific and a legitimate zero score is retained', async () => {
  const cfg = await config(); cfg.deepseek.apiKey = 'fixture-key';
  const rows = await run('AI Qualify, Score and Nurture', [lead({websiteText: 'Hospital administration appointment enquiries'})], {
    config: cfg, http: async request => {
      const prompt = request.body.messages[0].content;
      assert.match(prompt, /doctors, clinics and hospitals/);
      assert.match(prompt, /hospital administrators/);
      assert.match(prompt, /not automatically a decision-maker/);
      assert.match(prompt, /appointment enquiries/);
      assert.match(prompt, /"providerType":"hospital"/);
      return {choices: [{message: {content: JSON.stringify({score: 0, grade: 'D', contacts: [],
        qualification: 'Low CRM fit', nurture_strategy: 'Review reception needs', meta_crm_fit: 'low'})}}]};
    }
  });
  assert.equal(rows[0].json.score, 0);
  assert.equal(rows[0].json.grade, 'D');
  assert.equal(rows[0].json.metaCrmFit, 'low');
});

test('AI failure retains provider data and visibly marks the fallback', async () => {
  const cfg = await config(); cfg.deepseek.apiKey = 'fixture-key';
  const rows = await run('AI Qualify, Score and Nurture', [lead({websiteText: 'Clinic appointments'})], {
    config: cfg, http: async () => {throw Error('fixture service failure');}
  });
  assert.equal(rows[0].json.businessName, 'Example Hospital');
  assert.match(rows[0].json.aiAnalysis.error, /fixture service failure/);
});

test('email validation rejects null MX and retains non-email contact evidence', async () => {
  const rows = await run('Validate Emails + MX', [lead({emails: ['info@example.invalid'],
    contacts: [{full_name: 'Example Administrator', email: 'info@example.invalid', phone: '+922112345678'}]})], {
    http: async request => {
      assert.equal(request.url, 'https://dns.google/resolve');
      return {Answer: [{type: 15, data: '0 .'}]};
    }
  });
  assert.deepEqual(rows[0].json.emails, []);
  assert.equal(rows[0].json.contacts.length, 1);
  assert.equal(rows[0].json.contacts[0].email, null);
  assert.equal(rows[0].json._skipUpsert, undefined);
});

test('landline-only, low-score, no-social providers survive persistence preparation', async () => {
  const rows = await run('Prepare Healthcare Persistence', [lead({score: 0, grade: 'D',
    conversionTier: 'tier3_low_conversion', metaCrmFit: 'low', whatsappCapable: false})]);
  assert.equal(rows.length, 1); assert.notEqual(rows[0].json._skipUpsert, true);
  assert.equal(parametersFor(rows[0].json)[0], 'Example Hospital');
});

test('scope rejections are guarded from SQL persistence and still continue the search loop', async () => {
  const rows = await run('Prepare Healthcare Persistence', [
    lead({city: 'Hyderabad'}), lead({healthcareScope: {cityVerified: false}}),
    lead({providerType: 'pharmacy'}), lead({website: ''}),
    lead({_skipUpsert: true, skipReason: 'google_maps_no_results'})
  ]);
  for (const row of rows) {
    assert.equal(row.json._skipUpsert, true);
    assert.equal(parametersFor(row.json)[0], null);
  }
  const continued = await run('Continue Search Loop', rows.map(() => ({status: 'skipped', lead_id: null})));
  assert.equal(continued.length, 1);
  assert.equal(continued[0].json.loopContinue, true);
  assert.equal(continued[0].json.skipped, 5);
  assert.equal(workflow.connections['Prepare Healthcare Persistence'].main[0][0].node, 'Upsert Lead and Decision Makers');
});

test('query binding preserves all 30 schema-compatible parameters and JSON arrays', () => {
  const params = parametersFor(lead({score: 0, grade: 'D', socialProfiles: {}, aiAnalysis: {},
    whatsappNumbers: [], contacts: []}));
  assert.equal(params.length, 30); assert.equal(params[17], 0);
  assert.deepEqual(JSON.parse(params[23]), []);
  assert.deepEqual(JSON.parse(params[26]), []);
  assert.deepEqual(JSON.parse(params[15]), {});
});

test('original upsert SQL and PostgreSQL dump are byte-for-byte preserved', () => {
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.equal(hash(nodes['Upsert Lead and Decision Makers'].parameters.query),
    '4d39eccd58eb673da7ca19880f9afe65233f4db803e2989c801478306b3fdb2e');
  assert.equal(hash(fs.readFileSync(path.join(root, 'database/n8n_leads_full_backup.dump'))),
    '02ae9e6bb5bbe8be0c48a0f81299fde74d8525681fea24a510e99aca9322e702');
});

test('CSV download path and attachment filename identify the healthcare dataset', () => {
  assert.equal(nodes['Download Leads Webhook'].parameters.path, 'pakistan-healthcare-leads.csv');
  const headers = nodes['Return CSV Download'].parameters.options.responseHeaders.entries;
  assert.equal(headers.find(h => h.name === 'Content-Disposition').value,
    'attachment; filename="pakistan-healthcare-leads.csv"');
  assert.match(nodes['Read Presentable Lead Dataset'].parameters.query, /FROM pakistan_real_estate_leads/);
});
