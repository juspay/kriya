// Controlled test app family "shipping": server-rendered multi-page shipping details with server
// validation and an order review page. Plain Node ESM, node:http only, binds 127.0.0.1.
// Spec: the common contract plus the "shipping" family section of the e2e app specification.
import { createServer } from 'node:http';

export const family = 'shipping';
export const variants = ['A', 'B', 'C'];

// ---------------------------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------------------------

const DRAFT_KEYS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'line1',
  'line2',
  'city',
  'country',
  'region',
  'postalCode',
  'delivery',
  'giftWrap',
  'saveAddress',
];
const BOOLEAN_KEYS = new Set(['giftWrap', 'saveAddress']);
const CONTACT_KEYS = ['firstName', 'lastName', 'email', 'phone'];
const ADDRESS_KEYS = [
  'line1',
  'line2',
  'city',
  'country',
  'region',
  'postalCode',
  'delivery',
  'giftWrap',
  'saveAddress',
];

const COUNTRIES = [
  { code: 'US', name: 'United States', postal: /^\d{5}$/ },
  { code: 'CA', name: 'Canada', postal: /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/ },
  { code: 'GB', name: 'United Kingdom', postal: /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s?\d[A-Za-z]{2}$/ },
  { code: 'AU', name: 'Australia', postal: /^\d{4}$/ },
  { code: 'DE', name: 'Germany', postal: /^\d{5}$/ },
  { code: 'FR', name: 'France', postal: /^\d{5}$/ },
  { code: 'IN', name: 'India', postal: /^\d{6}$/ },
];
const COUNTRY_BY_CODE = new Map(COUNTRIES.map(country => [country.code, country]));

const US_STATES = [
  ['AL', 'Alabama'],
  ['AK', 'Alaska'],
  ['AZ', 'Arizona'],
  ['AR', 'Arkansas'],
  ['CA', 'California'],
  ['CO', 'Colorado'],
  ['CT', 'Connecticut'],
  ['DE', 'Delaware'],
  ['DC', 'District of Columbia'],
  ['FL', 'Florida'],
  ['GA', 'Georgia'],
  ['HI', 'Hawaii'],
  ['ID', 'Idaho'],
  ['IL', 'Illinois'],
  ['IN', 'Indiana'],
  ['IA', 'Iowa'],
  ['KS', 'Kansas'],
  ['KY', 'Kentucky'],
  ['LA', 'Louisiana'],
  ['ME', 'Maine'],
  ['MD', 'Maryland'],
  ['MA', 'Massachusetts'],
  ['MI', 'Michigan'],
  ['MN', 'Minnesota'],
  ['MS', 'Mississippi'],
  ['MO', 'Missouri'],
  ['MT', 'Montana'],
  ['NE', 'Nebraska'],
  ['NV', 'Nevada'],
  ['NH', 'New Hampshire'],
  ['NJ', 'New Jersey'],
  ['NM', 'New Mexico'],
  ['NY', 'New York'],
  ['NC', 'North Carolina'],
  ['ND', 'North Dakota'],
  ['OH', 'Ohio'],
  ['OK', 'Oklahoma'],
  ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'],
  ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'],
  ['SD', 'South Dakota'],
  ['TN', 'Tennessee'],
  ['TX', 'Texas'],
  ['UT', 'Utah'],
  ['VT', 'Vermont'],
  ['VA', 'Virginia'],
  ['WA', 'Washington'],
  ['WV', 'West Virginia'],
  ['WI', 'Wisconsin'],
  ['WY', 'Wyoming'],
];
const CA_PROVINCES = [
  ['AB', 'Alberta'],
  ['BC', 'British Columbia'],
  ['MB', 'Manitoba'],
  ['NB', 'New Brunswick'],
  ['NL', 'Newfoundland and Labrador'],
  ['NS', 'Nova Scotia'],
  ['NT', 'Northwest Territories'],
  ['NU', 'Nunavut'],
  ['ON', 'Ontario'],
  ['PE', 'Prince Edward Island'],
  ['QC', 'Quebec'],
  ['SK', 'Saskatchewan'],
  ['YT', 'Yukon'],
];
const US_CODES = new Set(US_STATES.map(([code]) => code));
const CA_CODES = new Set(CA_PROVINCES.map(([code]) => code));
const REGION_NAMES = new Map([...US_STATES, ...CA_PROVINCES]);

const DELIVERY_CENTS = { standard: 0, express: 1200, overnight: 2500 };
const DELIVERY_KEYS = Object.keys(DELIVERY_CENTS);
const GIFT_WRAP_CENTS = 400;

const ITEMS = {
  A: [
    { name: 'Cedar side table', qty: 1, cents: 8900 },
    { name: 'Linen throw, oat', qty: 2, cents: 3450 },
  ],
  B: [
    { name: 'Ridge 40L daypack', qty: 1, cents: 11900 },
    { name: 'Merino hiking socks (pair)', qty: 3, cents: 1800 },
  ],
  C: [
    { name: 'Wildflower honey, 500 g', qty: 2, cents: 1250 },
    { name: 'Sourdough starter kit', qty: 1, cents: 2800 },
    { name: 'Beeswax candles, set of 4', qty: 1, cents: 2200 },
    { name: 'Ceramic tea mug', qty: 2, cents: 1600 },
  ],
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_CHARS_RE = /^[0-9 +().-]+$/;

// ---------------------------------------------------------------------------------------------
// Variant specifications (labels, field names, wording and routes all differ on purpose)
// ---------------------------------------------------------------------------------------------

const SPECS = {
  A: {
    brand: 'Larkspur Home',
    idPrefix: 'a-',
    countries: ['US', 'CA', 'GB', 'AU', 'DE', 'FR', 'IN'],
    phoneRequired: false,
    defaults: { country: 'US', delivery: 'standard' },
    optionalMark: ' (optional)',
    routes: {
      entry: '/checkout/shipping',
      review: '/checkout/review',
      payment: '/checkout/payment',
    },
    fields: {
      firstName: { name: 'first_name', label: 'First name', autocomplete: 'given-name' },
      lastName: { name: 'last_name', label: 'Last name', autocomplete: 'family-name' },
      email: { name: 'email', label: 'Email address', autocomplete: 'email' },
      phone: { name: 'phone', label: 'Phone number', autocomplete: 'tel' },
      line1: { name: 'address1', label: 'Address line 1', autocomplete: 'address-line1' },
      line2: { name: 'address2', label: 'Address line 2', autocomplete: 'address-line2' },
      city: { name: 'city', label: 'City', autocomplete: 'address-level2' },
      country: { name: 'country', label: 'Country / region', autocomplete: 'country' },
      region: { name: 'state', label: 'State', autocomplete: 'address-level1' },
      postalCode: { name: 'zip', label: 'ZIP code', autocomplete: 'postal-code' },
      delivery: { name: 'delivery_method', label: 'Delivery method' },
      giftWrap: { name: 'gift_wrap', label: 'Add gift wrap ($4.00)' },
      saveAddress: { name: 'save_address', label: 'Save this address for future orders' },
    },
    delivery: {
      standard: ['Standard shipping', '5 to 7 business days'],
      express: ['Express shipping', '2 business days'],
      overnight: ['Overnight shipping', 'Next business day'],
    },
    messages: {
      firstName: { required: 'Enter your first name.' },
      lastName: { required: 'Enter your last name.' },
      email: { required: 'Enter your email address.', invalid: 'Enter a valid email address.' },
      phone: { required: 'Enter a phone number.', invalid: 'Enter a valid phone number.' },
      line1: { required: 'Enter the street address.' },
      city: { required: 'Enter the city.' },
      country: { required: 'Select a country.' },
      region: {
        required: 'Select a state.',
        invalid: 'Select a state or province that belongs to the chosen country.',
      },
      postalCode: {
        required: 'Enter a ZIP or postal code.',
        invalid: values =>
          values.country === 'US'
            ? 'Enter a 5-digit ZIP code.'
            : `Enter a valid postal code for ${countryName(values.country)}.`,
      },
      delivery: { required: 'Choose a delivery method.' },
    },
    flash: { saved: 'Your shipping details have been saved.' },
    failure:
      'We could not save your shipping details because of a problem on our side. Nothing was saved.',
  },
  B: {
    brand: 'Tidewater Outfitters',
    idPrefix: 'tw_',
    countries: ['US', 'CA', 'GB'],
    phoneRequired: true,
    defaults: { country: 'US', delivery: '' },
    optionalMark: ', optional',
    routes: {
      entry: '/order/delivery',
      review: '/order/confirm',
      payment: '/order/pay',
      discard: '/order/discard',
    },
    fields: {
      firstName: { name: 'given', label: 'Given name', autocomplete: 'given-name' },
      lastName: { name: 'family', label: 'Family name', autocomplete: 'family-name' },
      email: { name: 'mail', label: 'E-mail', autocomplete: 'email' },
      phone: { name: 'mobile', label: 'Mobile number', autocomplete: 'tel' },
      line1: { name: 'street', label: 'Street address', autocomplete: 'address-line1' },
      line2: { name: 'unit', label: 'Building, unit or floor', autocomplete: 'address-line2' },
      city: { name: 'town', label: 'Town or city', autocomplete: 'address-level2' },
      country: { name: 'ctry', label: 'Country', autocomplete: 'country' },
      region: { name: 'province', label: 'State or province', autocomplete: 'address-level1' },
      postalCode: { name: 'postcode', label: 'Postcode / ZIP', autocomplete: 'postal-code' },
      delivery: { name: 'speed', label: 'Delivery speed' },
      giftWrap: { name: 'gift', label: 'This is a gift, wrap it (+$4.00)' },
      saveAddress: { name: 'remember', label: 'Remember this address' },
    },
    delivery: {
      standard: ['Economy delivery', '5-7 working days'],
      express: ['Priority delivery', '2 working days'],
      overnight: ['Next-day delivery', 'Arrives tomorrow'],
    },
    messages: {
      firstName: { required: 'We need a given name.' },
      lastName: { required: 'We need a family name.' },
      email: {
        required: 'An e-mail address is needed for the receipt.',
        invalid: 'That e-mail address does not look right.',
      },
      phone: {
        required: 'A mobile number is needed so the courier can reach you.',
        invalid: 'That mobile number does not look right.',
      },
      line1: { required: 'Street address is missing.' },
      city: { required: 'Town or city is missing.' },
      country: { required: 'Pick a country.' },
      region: {
        required: 'Pick the state you are shipping to.',
        invalid: 'That region is not part of the selected country.',
      },
      postalCode: {
        required: 'Postcode is missing.',
        invalid: values =>
          values.country === 'US'
            ? 'ZIP codes have exactly 5 digits.'
            : values.country === 'CA'
              ? 'Canadian postcodes look like A1A 1A1.'
              : 'That is not a valid UK postcode.',
      },
      delivery: { required: 'Pick a delivery speed.' },
    },
    flash: { saved: 'Saved. We have your delivery details.' },
    failure: 'Something went wrong on our end and your details were not stored.',
  },
  C: {
    brand: 'Fernhill Market',
    idPrefix: 'fh-',
    countries: ['AU', 'CA', 'FR', 'DE', 'IN', 'GB', 'US'],
    phoneRequired: false,
    defaults: { country: '', delivery: 'standard' },
    optionalMark: ' (optional)',
    routes: {
      entry: '/checkout/contact',
      address: '/checkout/address',
      review: '/checkout/review',
      payment: '/checkout/payment',
      restart: '/checkout/restart',
    },
    fields: {
      firstName: { name: 'forename', label: 'Forename', autocomplete: 'given-name' },
      lastName: { name: 'surname', label: 'Surname', autocomplete: 'family-name' },
      email: { name: 'contactEmail', label: 'Contact email', autocomplete: 'email' },
      phone: { name: 'telephone', label: 'Telephone', autocomplete: 'tel' },
      line1: {
        name: 'streetLine',
        label: 'Street and house number',
        autocomplete: 'address-line1',
      },
      line2: { name: 'unitLine', label: 'Apartment, suite, unit', autocomplete: 'address-line2' },
      city: { name: 'locality', label: 'Locality', autocomplete: 'address-level2' },
      country: { name: 'countryCode', label: 'Country or territory', autocomplete: 'country' },
      region: {
        name: 'regionCode',
        label: 'State, province or region',
        autocomplete: 'address-level1',
      },
      postalCode: { name: 'postal', label: 'ZIP or postal code', autocomplete: 'postal-code' },
      delivery: { name: 'shippingService', label: 'Shipping service' },
      giftWrap: { name: 'giftPackaging', label: 'Include gift packaging for $4.00' },
      saveAddress: { name: 'keepAddress', label: 'Keep this address in my address book' },
    },
    delivery: {
      standard: ['Regular post', '1 to 2 weeks'],
      express: ['Fast courier', '2 to 3 days'],
      overnight: ['Courier by tomorrow', 'Next day'],
    },
    messages: {
      firstName: { required: 'Please give a forename.' },
      lastName: { required: 'Please give a surname.' },
      email: {
        required: 'Please give a contact email.',
        invalid: 'That contact email is not valid.',
      },
      phone: {
        required: 'Please give a telephone number.',
        invalid: 'That telephone number is not valid.',
      },
      line1: { required: 'Please give the street and house number.' },
      city: { required: 'Please give the locality.' },
      country: { required: 'Please choose a country or territory.' },
      region: {
        required: 'Please choose a state.',
        invalid: 'That state or province does not match the country.',
      },
      postalCode: {
        required: 'Please give a postal code.',
        invalid: values => `That postal code is not valid for ${countryName(values.country)}.`,
      },
      delivery: { required: 'Please choose a shipping service.' },
    },
    flash: {
      contact: 'Contact details saved.',
      address: 'Address and delivery options saved.',
    },
    failure: 'We hit a server error and could not save this step. Your changes were not kept.',
  },
};

const FIELD_NAME_TO_KEY = Object.fromEntries(
  Object.entries(SPECS).map(([id, spec]) => [
    id,
    Object.fromEntries(Object.entries(spec.fields).map(([key, def]) => [def.name, key])),
  ])
);

const CONTENT_PAGES = {
  home: ['Welcome', 'Browse the season’s picks, read our care guides and find a store near you.'],
  shop: ['Shop all', 'Everything we stock, from everyday basics to limited seasonal runs.'],
  new: [
    'New arrivals',
    'Fresh stock lands every Tuesday. Check back soon for the latest additions.',
  ],
  sale: [
    'Seasonal sale',
    'Selected lines are reduced while stocks last. Prices shown at checkout.',
  ],
  help: [
    'Help centre',
    'Answers about orders, delivery times, returns and caring for your purchase.',
  ],
  account: ['My account', 'Sign in to see past orders and manage saved addresses.'],
  returns: ['Returns and refunds', 'Unused items can be returned within 30 days of delivery.'],
  delivery: [
    'Delivery information',
    'Standard delivery takes a few working days; faster options are offered at checkout.',
  ],
  gift: ['Gift cards', 'Digital gift cards are delivered by email within a few minutes.'],
  privacy: ['Privacy policy', 'We keep only what we need to fulfil your order.'],
  terms: ['Terms of sale', 'The terms that apply to purchases made through this storefront.'],
  about: ['About us', 'A small team that cares about well made things.'],
  contact: ['Contact us', 'Reach customer care between 9am and 5pm on weekdays.'],
};

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ESCAPES[ch]);
const money = cents => `$${(cents / 100).toFixed(2)}`;
const clone = value => JSON.parse(JSON.stringify(value));
const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);

const SENSITIVE_KEY_RE = /pass(word|wd)?|card|cvv|cvc|otp|ssn|secret|token/i;

function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

// The shipping flow never asks for payment or credentials, but every logged value still passes
// through here so a card number or password typed into the wrong box never reaches state() or requests().
function maskValue(key, value) {
  const text = String(value);
  const compact = text.replace(/[ -]/g, '');
  const cardLike = /^\d{13,19}$/.test(compact) && luhnValid(compact);
  if (cardLike) return `****${compact.slice(-4)}`;
  return SENSITIVE_KEY_RE.test(key) && text !== '' ? '[masked]' : text;
}

function countryName(code) {
  return COUNTRY_BY_CODE.get(code)?.name ?? 'the selected country';
}

function blankFields(variant) {
  const spec = SPECS[variant];
  return {
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    line1: '',
    line2: '',
    city: '',
    country: spec.defaults.country,
    region: '',
    postalCode: '',
    delivery: spec.defaults.delivery,
    giftWrap: false,
    saveAddress: false,
  };
}

function normalizeInitial(initial, variant) {
  if (!isRecord(initial)) throw new TypeError('initial must be an object');
  const out = {};
  for (const [key, value] of Object.entries(initial)) {
    if (!DRAFT_KEYS.includes(key)) {
      throw new RangeError(`unknown initial option "${key}" (known: ${DRAFT_KEYS.join(', ')})`);
    }
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof value !== 'boolean') throw new TypeError(`initial.${key} must be a boolean`);
    } else if (typeof value !== 'string') {
      throw new TypeError(`initial.${key} must be a string`);
    }
    if (key === 'country' && value !== '' && !SPECS[variant].countries.includes(value)) {
      throw new RangeError(
        `initial.country must be one of ${SPECS[variant].countries.join(', ')} for variant ${variant}`
      );
    }
    if (key === 'region' && value !== '' && !REGION_NAMES.has(value)) {
      throw new RangeError('initial.region must be a US state or Canadian province code, or ""');
    }
    if (key === 'delivery' && value !== '' && !DELIVERY_KEYS.includes(value)) {
      throw new RangeError(`initial.delivery must be one of ${DELIVERY_KEYS.join(', ')}`);
    }
    out[key] = value;
  }
  return out;
}

function normalizeFaults(faults) {
  if (!isRecord(faults)) throw new TypeError('faults must be an object');
  const known = ['rerenderEveryMs', 'slowResponseMs', 'failWrites', 'misleadingSuccess'];
  for (const key of Object.keys(faults)) {
    if (!known.includes(key))
      throw new RangeError(`unknown fault "${key}" (known: ${known.join(', ')})`);
  }
  const ms = (key, value) => {
    if (value === undefined || value === false) return 0;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`faults.${key} must be a non-negative number`);
    }
    return value;
  };
  return {
    rerenderEveryMs: ms('rerenderEveryMs', faults.rerenderEveryMs),
    slowResponseMs: ms('slowResponseMs', faults.slowResponseMs),
    failWrites: faults.failWrites === true,
    misleadingSuccess: faults.misleadingSuccess === true,
  };
}

function validPhone(value) {
  if (!PHONE_CHARS_RE.test(value)) return false;
  const digits = value.replace(/\D/g, '').length;
  return digits >= 7 && digits <= 15;
}

function validate(variant, values, keys) {
  const spec = SPECS[variant];
  const errors = [];
  const add = (field, code) => errors.push({ field, code });
  const has = key => keys.includes(key);
  if (has('firstName') && !values.firstName) add('firstName', 'required');
  if (has('lastName') && !values.lastName) add('lastName', 'required');
  if (has('email')) {
    if (!values.email) add('email', 'required');
    else if (!EMAIL_RE.test(values.email)) add('email', 'invalid');
  }
  if (has('phone')) {
    if (!values.phone) {
      if (spec.phoneRequired) add('phone', 'required');
    } else if (!validPhone(values.phone)) add('phone', 'invalid');
  }
  if (has('line1') && !values.line1) add('line1', 'required');
  if (has('city') && !values.city) add('city', 'required');
  const countryOk = spec.countries.includes(values.country);
  if (has('country') && !countryOk) add('country', 'required');
  if (has('region')) {
    if (values.country === 'US') {
      if (!values.region) add('region', 'required');
      else if (!US_CODES.has(values.region)) add('region', 'invalid');
    } else if (values.country === 'CA' && values.region && !CA_CODES.has(values.region)) {
      add('region', 'invalid');
    }
  }
  if (has('postalCode')) {
    if (!values.postalCode) add('postalCode', 'required');
    else if (countryOk && !COUNTRY_BY_CODE.get(values.country).postal.test(values.postalCode)) {
      add('postalCode', 'invalid');
    }
  }
  if (has('delivery') && !(values.delivery in DELIVERY_CENTS)) add('delivery', 'required');
  return errors;
}

function normalizeValues(values) {
  if (!('region' in values) || values.country === 'US' || values.country === 'CA') return values;
  return { ...values, region: '' };
}

function readForm(variant, form, keys) {
  const spec = SPECS[variant];
  const values = {};
  for (const key of keys) {
    const name = spec.fields[key].name;
    values[key] = BOOLEAN_KEYS.has(key) ? form.has(name) : (form.get(name) ?? '').trim();
  }
  return values;
}

function errorMessages(variant, errors, values) {
  const out = {};
  for (const { field, code } of errors) {
    const entry = SPECS[variant].messages[field]?.[code];
    out[field] =
      typeof entry === 'function' ? entry(values) : (entry ?? 'This value is not valid.');
  }
  return out;
}

function cartUnits(variant) {
  return ITEMS[variant].reduce((sum, item) => sum + item.qty, 0);
}

function totals(variant, fields) {
  const subtotal = ITEMS[variant].reduce((sum, item) => sum + item.qty * item.cents, 0);
  const shipping = DELIVERY_CENTS[fields.delivery] ?? 0;
  const gift = fields.giftWrap ? GIFT_WRAP_CENTS : 0;
  return { subtotal, shipping, gift, total: subtotal + shipping + gift };
}

function regionLabel(country, region) {
  if (!region) return '';
  return country === 'US' || country === 'CA' ? (REGION_NAMES.get(region) ?? region) : region;
}

// ---------------------------------------------------------------------------------------------
// HTML building blocks
// ---------------------------------------------------------------------------------------------

const BASE_CSS = `
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
input[type=text],input[type=email],input[type=tel],input[type=search],select{font:inherit;padding:9px 10px;border:1px solid #b9b4a8;border-radius:4px;background:#fff;color:inherit;width:100%}
button{font:inherit;cursor:pointer}
fieldset{border:0;margin:0 0 22px;padding:0;min-width:0}
legend{padding:0}
h1,h2,h3{line-height:1.2}
address{font-style:normal}
dl{margin:0}
`;

const CSS = {
  A: `${BASE_CSS}
body{background:#f7f5f0;color:#1f2933}
a{color:#2f5d3a}
.promo{background:#2f5d3a;color:#fff;display:flex;justify-content:center;gap:36px;padding:8px 16px;font-size:13px}
.promo a{color:#fff}
header.site{display:flex;align-items:center;gap:28px;padding:14px 32px;background:#fff;border-bottom:1px solid #e3ded3}
.logo{font:700 22px Georgia,serif;color:#2f5d3a;text-decoration:none}
.search{flex:1;display:flex;gap:6px;max-width:420px}
.search button{padding:8px 14px;border:1px solid #2f5d3a;background:#fff;color:#2f5d3a;border-radius:4px}
nav.main{display:flex;gap:20px;margin-left:auto}
nav.main a{color:#1f2933;text-decoration:none}
main{max-width:1160px;margin:0 auto;padding:22px 32px 48px}
ol.steps{display:flex;gap:10px;list-style:none;padding:0;margin:0 0 8px;font-size:13px;color:#6b665b}
ol.steps li+li::before{content:"/";margin-right:10px}
ol.steps [aria-current]{color:#1f2933;font-weight:600}
h1{font-size:28px;margin:6px 0 18px}
.cols{display:grid;grid-template-columns:1fr 340px;gap:28px;align-items:start}
.card{background:#fff;border:1px solid #e3ded3;border-radius:8px;padding:22px 24px}
legend{font-weight:700;font-size:17px;margin-bottom:10px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.field{margin-bottom:14px}
.field label{display:block;font-weight:600;margin-bottom:4px;font-size:14px}
.field.has-error input,.field.has-error select{border-color:#b3261e}
.error{color:#b3261e;margin:4px 0 0;font-size:13px}
.banner{padding:12px 16px;border-radius:6px;margin-bottom:16px}
.banner.error{background:#fde8e6;border:1px solid #e9a8a3;color:#7a1710}
.banner.success{background:#e6f3ea;border:1px solid #a6cfb2;color:#1d4a2a}
.banner.info{background:#eaf1f8;border:1px solid #b5cbe0;color:#1e3f5c}
.opt{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid #d6d1c4;border-radius:6px;margin-bottom:8px}
.opt label{flex:1;display:flex;justify-content:space-between;gap:12px}
.opt small{color:#6b665b;flex:1}
.check{display:flex;gap:10px;align-items:center;margin:6px 0}
.check input{width:18px;height:18px}
.actions{display:flex;align-items:center;gap:14px;margin-top:8px}
.btn{display:inline-block;padding:11px 22px;border-radius:5px;border:1px solid #2f5d3a;background:#fff;color:#2f5d3a;text-decoration:none;font-weight:600}
.btn.primary{background:#2f5d3a;color:#fff}
.btn.danger{border-color:#b3261e;color:#b3261e}
aside.summary{background:#fff;border:1px solid #e3ded3;border-radius:8px;padding:18px 20px}
aside.summary h2{font-size:18px;margin:0 0 10px}
aside.summary ul{list-style:none;padding:0;margin:0 0 12px}
aside.summary li{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eee9de}
.sum-row{display:flex;justify-content:space-between;padding:3px 0}
.sum-row.total{font-weight:700;border-top:1px solid #e3ded3;margin-top:6px;padding-top:8px}
aside .promo-form{margin:14px 0;padding-top:12px;border-top:1px solid #eee9de}
aside .promo-form .row{display:flex;gap:6px}
aside .promo-form button{padding:8px 12px}
aside .linkish{margin-top:12px}
aside .linkish button{background:none;border:0;color:#b3261e;text-decoration:underline;padding:0}
dl.review{display:grid;grid-template-columns:140px 1fr;gap:6px 14px}
dl.review dt{color:#6b665b}
dl.review dd{margin:0}
section.card{margin-bottom:16px}
section.card h2{font-size:18px;margin:0 0 10px}
footer.site{background:#fff;border-top:1px solid #e3ded3;padding:26px 32px;display:flex;gap:48px;flex-wrap:wrap;align-items:flex-start}
footer.site h2{font-size:16px;margin:0 0 8px}
footer.site form{display:flex;gap:6px;align-items:center}
footer.site label{font-size:13px;margin-right:4px;white-space:nowrap}
footer.site button{white-space:nowrap;padding:8px 14px}
footer.site nav{display:flex;gap:18px;margin-left:auto;font-size:14px}
table.items{width:100%;border-collapse:collapse}
table.items th,table.items td{text-align:left;padding:8px 6px;border-bottom:1px solid #e3ded3}
`,
  B: `${BASE_CSS}
body{background:#eef3f6;color:#17262f}
a{color:#0b5c7e}
header.top{background:#0d2f3f;color:#fff;display:flex;align-items:center;gap:24px;padding:12px 28px}
header.top a{color:#d6ecf5;text-decoration:none}
header.top .brand{font:800 20px "Trebuchet MS",sans-serif;letter-spacing:.5px;color:#fff}
header.top nav{display:flex;gap:18px;margin-left:auto;font-size:14px}
header.top .secure{font-size:12px;opacity:.8}
main{max-width:720px;margin:0 auto;padding:26px 20px 70px}
main h1{font-size:26px;margin:0 0 6px}
.lede{margin:0 0 18px;color:#4a6270}
.panel{background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(13,47,63,.18);padding:22px 24px;margin-bottom:18px}
.panel legend,.panel h2{font-size:17px;font-weight:700;margin:0 0 12px}
.fld{margin-bottom:14px;display:flex;flex-direction:column}
.fld .float{display:flex;flex-direction:column-reverse}
.fld .float label{font-size:13px;font-weight:600;color:#33505f;margin-bottom:4px}
.fld .err{order:-1;margin:0 0 4px;color:#a3201a;font-size:13px;font-weight:600}
.fld.bad input,.fld.bad select{border-color:#a3201a;background:#fff6f5}
.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.cards{display:grid;gap:10px}
.card-opt{display:grid;grid-template-columns:24px 1fr auto;gap:2px 10px;align-items:center;padding:12px 14px;border:2px solid #cfdde5;border-radius:8px;background:#fafcfd;cursor:pointer}
.card-opt input{grid-row:1/3;width:18px;height:18px}
.card-opt .t{font-weight:700}
.card-opt .d{color:#4a6270;font-size:13px;grid-column:2}
.card-opt .p{grid-row:1/3;grid-column:3;font-weight:700}
.check-line{display:flex;gap:10px;align-items:flex-start;margin:8px 0}
.check-line input{margin-top:4px;width:18px;height:18px}
.err-line{color:#a3201a;font-size:13px;font-weight:600;margin:0 0 6px}
.note{padding:12px 16px;border-radius:8px;margin-bottom:16px}
.note.error{background:#fdecea;border-left:5px solid #a3201a}
.note.success{background:#e5f4ea;border-left:5px solid #1f7a3a}
.note.info{background:#e6f0f7;border-left:5px solid #0b5c7e}
.row-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.cta{background:#0b5c7e;color:#fff;border:0;border-radius:8px;padding:13px 26px;font-weight:700;text-decoration:none;display:inline-block}
.quiet{background:none;border:1px solid #9bb4c2;color:#33505f;border-radius:8px;padding:12px 18px}
.warn{background:none;border:0;color:#a3201a;text-decoration:underline;padding:0}
details.promo-box{margin:10px 0}
details.promo-box summary{cursor:pointer;font-weight:600}
details.promo-box form{display:flex;gap:8px;margin-top:8px}
table.lines{width:100%;border-collapse:collapse}
table.lines td,table.lines th{padding:8px 4px;border-bottom:1px solid #e1eaef;text-align:left}
table.lines td:last-child,table.lines th:last-child{text-align:right}
.kv{display:grid;grid-template-columns:150px 1fr;gap:6px 12px}
.kv dt{color:#4a6270}
.kv dd{margin:0}
footer.bottom{background:#0d2f3f;color:#d6ecf5;padding:24px 28px}
footer.bottom a{color:#d6ecf5}
footer.bottom form{display:flex;gap:8px;max-width:520px;align-items:center}
footer.bottom label{white-space:nowrap}
footer.bottom .links{display:flex;gap:18px;margin-top:14px;font-size:13px}
details.chat{position:fixed;right:18px;bottom:18px;background:#fff;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,.25);padding:10px 14px;max-width:260px}
details.chat summary{cursor:pointer;font-weight:700}
`,
  C: `${BASE_CSS}
body{background:#fffdf8;color:#2b2a26}
a{color:#7a4a12}
.announce{background:#f3e3c3;text-align:center;padding:10px 16px;font-size:14px;line-height:1.4}
.announce p{margin:0}
header.bar{display:flex;align-items:center;justify-content:space-between;padding:20px 48px;border-bottom:1px solid #ece3d0}
header.bar .mark{font:700 26px Georgia,serif;color:#7a4a12;text-decoration:none}
header.bar nav{display:flex;gap:22px;font-size:14px}
header.bar nav a{text-decoration:none;color:#2b2a26}
main{max-width:760px;margin:0 auto;padding:30px 24px 64px}
.eyebrow{margin:0;font-size:13px;color:#8a7f69;text-transform:uppercase;letter-spacing:.08em}
main h1{font-size:30px;margin:4px 0 14px}
ol.stepper{display:flex;gap:8px;list-style:none;padding:0;margin:0 0 22px}
ol.stepper li{flex:1;padding:10px 12px;border-radius:6px;background:#f3ecdc;color:#8a7f69;font-size:14px}
ol.stepper li[aria-current]{background:#7a4a12;color:#fff;font-weight:600}
.bag{border:1px solid #ece3d0;border-radius:10px;padding:18px 22px;margin-bottom:26px;background:#fff}
.bag h2{margin:0 0 10px;font-size:18px}
.bag ul{list-style:none;padding:0;margin:0}
.bag li{display:flex;justify-content:space-between;align-items:center;padding:20px 0;border-bottom:1px solid #f1eadb;min-height:72px}
.bag .redeem{margin-top:16px;display:flex;gap:8px;align-items:end}
.bag .redeem div{flex:1}
.bag .redeem label{display:block;font-size:13px;margin-bottom:4px}
.row{margin-bottom:26px}
.row>label,.row>.lbl{display:block;font-weight:600;margin-bottom:6px}
.msg{color:#9b2c1d;margin:6px 0 0;font-size:14px}
.row.problem input,.row.problem select{border-color:#9b2c1d;border-width:2px}
.summary-box{background:#fbeae6;border:2px solid #9b2c1d;border-radius:8px;padding:14px 18px;margin-bottom:24px}
.summary-box h2{margin:0 0 6px;font-size:17px}
.summary-box ul{margin:0;padding-left:20px}
.flash{padding:12px 16px;border-radius:8px;margin-bottom:20px}
.flash.success{background:#e8f2e3;border:1px solid #b5d3a8}
.flash.error{background:#fbeae6;border:1px solid #e4b0a6}
.flash.info{background:#eef0f8;border:1px solid #bcc3e0}
.tiles{display:grid;gap:12px}
.tile{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:22px 18px;border:2px solid #e2d6bd;border-radius:10px;background:#fff;cursor:pointer}
.tile input{width:20px;height:20px}
.tile .body{flex:1}
.tile .body small{display:block;color:#8a7f69}
.tick{display:flex;gap:12px;align-items:flex-start;margin:20px 0}
.tick input{width:20px;height:20px;margin-top:3px}
.nav-actions{display:flex;align-items:center;gap:18px;margin-top:44px;flex-wrap:wrap}
.go{background:#7a4a12;color:#fff;border:0;padding:15px 34px;border-radius:8px;font-weight:700;text-decoration:none;display:inline-block}
.back{color:#7a4a12}
.plain{background:none;border:0;color:#9b2c1d;text-decoration:underline;padding:0}
.outline{background:#fff;border:1px solid #7a4a12;color:#7a4a12;border-radius:6px;padding:9px 14px}
.trust{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:0 0 28px}
.trust div{background:#f8f2e4;border-radius:8px;padding:14px;font-size:14px}
.trust strong{display:block}
.rv{display:grid;grid-template-columns:1fr auto;gap:8px 16px;align-items:baseline;border:1px solid #ece3d0;border-radius:10px;padding:18px 22px;margin-bottom:16px;background:#fff}
.rv h2{grid-column:1;grid-row:1;margin:0;font-size:18px}
.rv .edit{grid-column:2;grid-row:1}
.rv dl{grid-column:1/-1;display:grid;grid-template-columns:170px 1fr;gap:8px 16px}
.rv dt{color:#8a7f69}
.rv dd{margin:0}
.tot{display:flex;justify-content:space-between;padding:4px 0}
.tot.grand{font-weight:700;border-top:1px solid #ece3d0;margin-top:8px;padding-top:10px}
footer.base{background:#2b2a26;color:#efe8d6;padding:34px 48px}
footer.base a{color:#efe8d6}
footer.base form{display:flex;gap:10px;align-items:end;max-width:560px}
footer.base form div{flex:1}
footer.base label{display:block;font-size:13px;margin-bottom:4px}
footer.base nav{display:flex;gap:20px;margin-top:20px;font-size:14px}
`,
};

function rerenderScript(ms) {
  return `<script>(function(){setInterval(function(){var old=document.querySelector('main');if(!old||!old.parentNode)return;var fresh=old.cloneNode(true);var a=old.querySelectorAll('input,select,textarea');var b=fresh.querySelectorAll('input,select,textarea');var focus=-1;var sel=null;for(var i=0;i<a.length;i++){var o=a[i];var n=b[i];if(o===document.activeElement){focus=i;try{sel=[o.selectionStart,o.selectionEnd];}catch(e){}}if(o.type==='checkbox'||o.type==='radio'){n.checked=o.checked;}else{n.value=o.value;}}old.replaceWith(fresh);if(focus>=0){var f=b[focus];f.focus();if(sel&&sel[0]!==null){try{f.setSelectionRange(sel[0],sel[1]);}catch(e){}}}},${Number(ms)});})();</script>`;
}

function flashHtml(variant, flash) {
  if (!flash) return '';
  const role = flash.kind === 'error' ? 'alert' : 'status';
  const cls = variant === 'A' ? 'banner' : variant === 'B' ? 'note' : 'flash';
  return `<div class="${cls} ${flash.kind}" role="${role}">${esc(flash.text)}</div>`;
}

function orderLines(variant) {
  return ITEMS[variant].map(item => ({ ...item, label: `${item.name} × ${item.qty}` }));
}

// --- shared control builders (markup differs per variant) -------------------------------------

function controlId(variant, key, suffix = '') {
  return `${SPECS[variant].idPrefix}${SPECS[variant].fields[key].name}${suffix}`;
}

function isRequired(variant, key) {
  if (key === 'line2') return false;
  if (key === 'phone') return SPECS[variant].phoneRequired;
  return true;
}

function labelText(variant, key) {
  const spec = SPECS[variant];
  return spec.fields[key].label + (isRequired(variant, key) ? '' : spec.optionalMark);
}

function inputAttrs(variant, c, key, extra = '') {
  const def = SPECS[variant].fields[key];
  const id = controlId(variant, key);
  const err = c.messages[key];
  return [
    `id="${id}"`,
    `name="${def.name}"`,
    def.autocomplete ? `autocomplete="${def.autocomplete}"` : '',
    isRequired(variant, key) ? 'required' : '',
    err ? 'aria-invalid="true"' : '',
    err ? `aria-describedby="${id}-error"` : '',
    extra,
  ]
    .filter(Boolean)
    .join(' ');
}

function errorHtml(variant, c, key, tag = 'p', cls = 'error') {
  const err = c.messages[key];
  if (!err) return '';
  const role = variant === 'C' ? '' : ' role="alert"';
  return `<${tag} class="${cls}" id="${controlId(variant, key)}-error"${role}>${esc(err)}</${tag}>`;
}

function textControl(variant, c, key, type = 'text') {
  const id = controlId(variant, key);
  const value = esc(c.values[key]);
  const input = `<input type="${type}" ${inputAttrs(variant, c, key)} value="${value}">`;
  const label = esc(labelText(variant, key));
  if (variant === 'A') {
    return `<div class="field${c.messages[key] ? ' has-error' : ''}"><label for="${id}">${label}</label>${input}${errorHtml('A', c, key)}</div>`;
  }
  if (variant === 'B') {
    return `<div class="fld${c.messages[key] ? ' bad' : ''}">${errorHtml('B', c, key, 'p', 'err')}<div class="float">${input}<label for="${id}">${label}</label></div></div>`;
  }
  return `<div class="row${c.messages[key] ? ' problem' : ''}"><label for="${id}">${label}</label>${input}${errorHtml('C', c, key, 'p', 'msg')}</div>`;
}

function regionOptions(value, placeholder) {
  const opt = ([code, name]) =>
    `<option value="${code}"${value === code ? ' selected' : ''}>${esc(name)}</option>`;
  return (
    `<option value=""${value === '' ? ' selected' : ''}>${esc(placeholder)}</option>` +
    `<optgroup label="United States">${US_STATES.map(opt).join('')}</optgroup>` +
    `<optgroup label="Canada">${CA_PROVINCES.map(opt).join('')}</optgroup>`
  );
}

function countryOptions(variant, value, placeholder) {
  const options = SPECS[variant].countries.map(code => {
    const name = countryName(code);
    return `<option value="${code}"${value === code ? ' selected' : ''}>${esc(name)}</option>`;
  });
  return `<option value=""${value === '' ? ' selected' : ''}>${esc(placeholder)}</option>${options.join('')}`;
}

function selectControl(variant, c, key, optionsHtml) {
  const id = controlId(variant, key);
  const select = `<select ${inputAttrs(variant, c, key)}>${optionsHtml}</select>`;
  const label = esc(labelText(variant, key));
  if (variant === 'A') {
    return `<div class="field${c.messages[key] ? ' has-error' : ''}"><label for="${id}">${label}</label>${select}${errorHtml('A', c, key)}</div>`;
  }
  if (variant === 'B') {
    return `<div class="fld${c.messages[key] ? ' bad' : ''}">${errorHtml('B', c, key, 'p', 'err')}<div class="float">${select}<label for="${id}">${label}</label></div></div>`;
  }
  return `<div class="row${c.messages[key] ? ' problem' : ''}"><label for="${id}">${label}</label>${select}${errorHtml('C', c, key, 'p', 'msg')}</div>`;
}

function deliveryControl(variant, c) {
  const spec = SPECS[variant];
  const def = spec.fields.delivery;
  const id = controlId(variant, 'delivery');
  const err = c.messages.delivery;
  const describedBy = err ? ` aria-describedby="${id}-error"` : '';
  const radio = (k, wrapped) => {
    const checked = c.values.delivery === k ? ' checked' : '';
    const rid = `${id}-${k}`;
    const input = `<input type="radio" id="${rid}" name="${def.name}" value="${k}"${checked}${err ? ' aria-invalid="true"' : ''}>`;
    const [title, eta] = spec.delivery[k];
    const price = DELIVERY_CENTS[k] === 0 ? 'Free' : money(DELIVERY_CENTS[k]);
    return { input, rid, title, eta, price };
  };
  if (variant === 'A') {
    const rows = DELIVERY_KEYS.map(k => {
      const r = radio(k);
      return `<div class="opt">${r.input}<label for="${r.rid}"><span>${esc(r.title)}</span><small>${esc(r.eta)}</small><b>${r.price}</b></label></div>`;
    }).join('');
    return `<fieldset${describedBy}><legend>${esc(def.label)}</legend>${errorHtml('A', c, 'delivery')}${rows}</fieldset>`;
  }
  if (variant === 'B') {
    const rows = DELIVERY_KEYS.map(k => {
      const r = radio(k);
      return `<label class="card-opt">${r.input}<span class="t">${esc(r.title)}</span><span class="d">${esc(r.eta)}</span><span class="p">${r.price}</span></label>`;
    }).join('');
    return `<section class="panel"><fieldset style="margin:0"${describedBy}><legend>${esc(def.label)}</legend>${errorHtml('B', c, 'delivery', 'p', 'err-line')}<div class="cards">${rows}</div></fieldset></section>`;
  }
  const rows = DELIVERY_KEYS.map(k => {
    const r = radio(k);
    return `<label class="tile" for="${r.rid}"><span class="body">${esc(r.title)}<small>${esc(r.eta)}</small></span><span>${r.price}</span>${r.input}</label>`;
  }).join('');
  return `<div class="row${err ? ' problem' : ''}" role="radiogroup" aria-labelledby="${id}-legend"${describedBy}><span class="lbl" id="${id}-legend">${esc(def.label)}</span><div class="tiles">${rows}</div>${errorHtml('C', c, 'delivery', 'p', 'msg')}</div>`;
}

function countryRadios(c) {
  const variant = 'B';
  const spec = SPECS.B;
  const def = spec.fields.country;
  const id = controlId('B', 'country');
  const err = c.messages.country;
  const rows = spec.countries
    .map(code => {
      const checked = c.values.country === code ? ' checked' : '';
      return `<label class="check-line"><input type="radio" name="${def.name}" value="${code}"${checked}${err ? ' aria-invalid="true"' : ''}><span>${esc(countryName(code))}</span></label>`;
    })
    .join('');
  return `<fieldset${err ? ` aria-describedby="${id}-error"` : ''}><legend>${esc(def.label)}</legend>${errorHtml(variant, c, 'country', 'p', 'err-line')}${rows}</fieldset>`;
}

function checkControl(variant, c, key) {
  const def = SPECS[variant].fields[key];
  const id = controlId(variant, key);
  const checked = c.values[key] ? ' checked' : '';
  const value = variant === 'A' ? 'yes' : variant === 'B' ? '1' : 'true';
  const input = `<input type="checkbox" id="${id}" name="${def.name}" value="${value}"${checked}>`;
  const label = esc(def.label);
  if (variant === 'A')
    return `<div class="check">${input}<label for="${id}">${label}</label></div>`;
  if (variant === 'B') return `<label class="check-line">${input}<span>${label}</span></label>`;
  return `<div class="tick">${input}<label for="${id}">${label}</label></div>`;
}

// --- summaries ---------------------------------------------------------------------------------

function itemsList(variant) {
  return `<ul>${orderLines(variant)
    .map(
      item => `<li><span>${esc(item.label)}</span><span>${money(item.qty * item.cents)}</span></li>`
    )
    .join('')}</ul>`;
}

function promoForm(variant, backPath) {
  const back = `<input type="hidden" name="back" value="${esc(backPath)}">`;
  if (variant === 'A') {
    return `<form class="promo-form" method="post" action="/promo"><label for="a-code">Discount code</label><div class="row"><input type="text" id="a-code" name="code" autocomplete="off">${back}<button type="submit">Apply</button></div></form>`;
  }
  if (variant === 'B') {
    return `<details class="promo-box"><summary>Have a promo code?</summary><form method="post" action="/promo"><label class="sr" for="tw_promo">Promo code</label><input type="text" id="tw_promo" name="code" autocomplete="off">${back}<button type="submit" class="quiet">Redeem</button></form></details>`;
  }
  return `<form class="redeem" method="post" action="/promo"><div><label for="fh-voucher">Gift card or voucher code</label><input type="text" id="fh-voucher" name="code" autocomplete="off">${back}</div><button type="submit" class="outline">Redeem</button></form>`;
}

function emptyCartForm(variant) {
  if (variant === 'A') {
    return `<form class="linkish" method="post" action="/cart/empty"><button type="submit">Empty cart</button></form>`;
  }
  if (variant === 'B') {
    return `<form method="post" action="/cart/empty"><button type="submit" class="warn">Remove everything from my cart</button></form>`;
  }
  return `<form method="post" action="/cart/empty"><button type="submit" class="plain">Remove all items</button></form>`;
}

function summaryA(c, full) {
  const t = totals('A', c.fields);
  const rows = full
    ? `<div class="sum-row"><span>Subtotal</span><span>${money(t.subtotal)}</span></div><div class="sum-row"><span>Shipping</span><span>${t.shipping === 0 ? 'Free' : money(t.shipping)}</span></div>${t.gift ? `<div class="sum-row"><span>Gift wrap</span><span>${money(t.gift)}</span></div>` : ''}<div class="sum-row total"><span>Total</span><span>${money(t.total)}</span></div>`
    : `<div class="sum-row"><span>Subtotal</span><span>${money(t.subtotal)}</span></div><div class="sum-row"><span>Shipping</span><span>Calculated next</span></div>`;
  return `<aside class="summary" aria-labelledby="a-sum"><h2 id="a-sum">Order summary</h2>${itemsList('A')}${rows}${promoForm('A', c.path)}<a href="/cart">Edit cart</a>${emptyCartForm('A')}</aside>`;
}

// --- shells ------------------------------------------------------------------------------------

function cartLabel(variant, c) {
  return c.cartEmpty ? 0 : cartUnits(variant);
}

function shell(variant, c, { title, content }) {
  const script = c.faults.rerenderEveryMs > 0 ? rerenderScript(c.faults.rerenderEveryMs) : '';
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} - ${esc(SPECS[variant].brand)}</title><style>${CSS[variant]}</style></head>`;
  const n = cartLabel(variant, c);
  const entry = SPECS[variant].routes.entry;
  if (variant === 'A') {
    return `${head}<body>
<div class="promo"><span>Free standard shipping on orders over $75</span><span>Spring sale: 15% off outdoor furniture <a href="/p/sale">Shop the sale</a></span></div>
<header class="site"><a class="logo" href="/p/home">Larkspur Home</a>
<form class="search" role="search" action="/search" method="get"><label class="sr" for="a-q">Search products</label><input type="search" id="a-q" name="q" placeholder="Search the store"><button type="submit">Search</button></form>
<nav class="main" aria-label="Main"><a href="/p/shop">Shop</a><a href="/p/new">New in</a><a href="/p/sale">Sale</a><a href="/p/help">Help</a><a href="/p/account">My account</a><a href="/cart">Cart (${n})</a></nav></header>
<main>${content}</main>
<footer class="site"><div><h2>Get 10% off your first order</h2><form method="post" action="/newsletter"><label for="a-news">Your email</label><input type="email" id="a-news" name="email" autocomplete="email"><button type="submit">Sign up</button></form></div>
<nav aria-label="Footer"><a href="/p/returns">Returns</a><a href="/p/delivery">Delivery information</a><a href="/p/gift">Gift cards</a><a href="/p/privacy">Privacy</a><a href="/p/terms">Terms</a></nav></footer>
${script}</body></html>`;
  }
  if (variant === 'B') {
    return `${head}<body>
<header class="top"><a class="brand" href="/p/home">TIDEWATER</a><span class="secure">Secure checkout</span>
<nav aria-label="Primary"><a href="/p/shop">Gear</a><a href="/p/sale">Clearance</a><a href="/p/about">Stores</a><a href="/p/help">Support</a><a href="/cart">Bag (${n})</a></nav></header>
<main>${content}</main>
<footer class="bottom"><form method="post" action="/newsletter"><label for="tw_news">Join the Tidewater list</label><input type="email" id="tw_news" name="email" placeholder="you@example.com" autocomplete="email"><button type="submit" class="quiet" style="color:#fff;border-color:#d6ecf5">Subscribe</button></form>
<div class="links"><a href="/p/returns">Returns</a><a href="/p/delivery">Shipping rates</a><a href="/p/contact">Contact</a><a href="/p/privacy">Privacy</a><a href="/p/terms">Terms</a></div></footer>
<details class="chat"><summary>Chat with us</summary><p>Our chat team is online from 9am to 5pm, Monday to Friday.</p></details>
${script}</body></html>`;
  }
  return `${head}<body>
<div class="announce"><p>Free jar of preserves with orders over $50. Slow-baked goods ship on Mondays and Thursdays.</p></div>
<header class="bar"><a class="mark" href="/p/home">Fernhill Market</a><nav aria-label="Site"><a href="/p/shop">Pantry</a><a href="/p/new">Seasonal</a><a href="/p/gift">Gift boxes</a><a href="/p/help">Questions</a><a href="/cart">Bag (${n})</a></nav></header>
<main>${content}</main>
<footer class="base"><form method="post" action="/newsletter"><div><label for="fh-news">Email for our weekly newsletter</label><input type="email" id="fh-news" name="email" autocomplete="email"></div><button type="submit" class="outline">Join</button></form>
<nav aria-label="Footer links"><a href="/p/about">Our story</a><a href="/p/delivery">Delivery</a><a href="/p/returns">Returns</a><a href="/p/privacy">Privacy</a><a href="/p/terms">Terms</a><a href="${entry}">Checkout</a></nav></footer>
${script}</body></html>`;
}

// ---------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------

function formPageA(c) {
  const spec = SPECS.A;
  const n = c.errors.length;
  const summary = n
    ? `<div class="banner error" role="alert"><strong>${n === 1 ? 'There is 1 problem' : `There are ${n} problems`} with the details you entered.</strong></div>`
    : '';
  const regionName = spec.fields.region;
  const content = `<ol class="steps" aria-label="Checkout progress"><li><a href="/cart">Cart</a></li><li aria-current="step">Shipping</li><li>Review</li><li>Payment</li></ol>
<h1>Shipping details</h1>${flashHtml('A', c.flash)}${summary}
<div class="cols"><form class="card" method="post" action="${spec.routes.entry}" novalidate>
<fieldset><legend>Contact information</legend>
<div class="grid2">${textControl('A', c, 'firstName')}${textControl('A', c, 'lastName')}</div>
${textControl('A', c, 'email', 'email')}${textControl('A', c, 'phone', 'tel')}</fieldset>
<fieldset><legend>Delivery address</legend>
${textControl('A', c, 'line1')}${textControl('A', c, 'line2')}${textControl('A', c, 'city')}
${selectControl('A', c, 'country', countryOptions('A', c.values.country, 'Select a country'))}
<div class="grid2">${selectControl('A', c, 'region', regionOptions(c.values.region, `Select ${regionName.label.toLowerCase()}`))}${textControl('A', c, 'postalCode')}</div></fieldset>
${deliveryControl('A', c)}
<fieldset><legend>Extras</legend>${checkControl('A', c, 'giftWrap')}${checkControl('A', c, 'saveAddress')}</fieldset>
<div class="actions"><button class="btn primary" type="submit">Review order</button><a href="${spec.routes.entry}?clear=1">Clear form</a><a href="/cart">Back to cart</a></div>
</form>${summaryA(c, false)}</div>`;
  return shell('A', c, { title: 'Shipping details', content });
}

function formPageB(c) {
  const spec = SPECS.B;
  const content = `<h1>Where is it going?</h1><p class="lede">Tell us where to deliver your order and who will be there to receive it.</p>
${flashHtml('B', c.flash)}
<form method="post" action="${spec.routes.entry}" novalidate>
<section class="panel"><h2>Delivery address</h2>
${countryRadios(c)}
${textControl('B', c, 'line1')}${textControl('B', c, 'line2')}
<div class="two">${textControl('B', c, 'city')}${textControl('B', c, 'postalCode')}</div>
${selectControl('B', c, 'region', regionOptions(c.values.region, 'Choose a state or province'))}</section>
<section class="panel"><h2>Who is receiving it?</h2>
<div class="two">${textControl('B', c, 'firstName')}${textControl('B', c, 'lastName')}</div>
${textControl('B', c, 'email', 'email')}${textControl('B', c, 'phone', 'tel')}</section>
${deliveryControl('B', c)}
<section class="panel">${checkControl('B', c, 'giftWrap')}${checkControl('B', c, 'saveAddress')}</section>
<div class="row-actions"><button class="cta" type="submit">Confirm and review</button><a href="/cart">Return to bag</a></div>
</form>
<form method="post" action="${spec.routes.discard}" style="margin-top:18px"><button type="submit" class="warn">Discard changes</button></form>
<section class="panel" style="margin-top:22px"><h2>Your bag</h2>${bagTableB(c)}${promoForm('B', c.path)}${emptyCartForm('B')}</section>`;
  return shell('B', c, { title: 'Delivery details', content });
}

function bagTableB(c) {
  const t = totals('B', c.fields);
  const rows = orderLines('B')
    .map(
      item =>
        `<tr><td>${esc(item.name)} × ${item.qty}</td><td>${money(item.qty * item.cents)}</td></tr>`
    )
    .join('');
  return `<table class="lines"><tbody>${rows}<tr><th scope="row">Subtotal</th><th>${money(t.subtotal)}</th></tr></tbody></table>`;
}

function bagC(c) {
  const lines = orderLines('C')
    .map(
      item =>
        `<li><span>${esc(item.name)} × ${item.qty}</span><span>${money(item.qty * item.cents)}</span></li>`
    )
    .join('');
  return `<section class="bag" aria-labelledby="fh-bag"><h2 id="fh-bag">Your bag</h2><ul>${lines}</ul>${promoForm('C', c.path)}</section>`;
}

function stepperC(step) {
  const items = [
    ['contact', 'Your details'],
    ['address', 'Delivery'],
    ['review', 'Review'],
  ];
  return `<ol class="stepper" aria-label="Progress">${items
    .map(([id, text]) => `<li${id === step ? ' aria-current="step"' : ''}>${esc(text)}</li>`)
    .join('')}</ol>`;
}

function summaryBoxC(c) {
  if (!c.errors.length) return '';
  const items = c.errors
    .map(
      ({ field }) => `<li><a href="#${controlId('C', field)}">${esc(c.messages[field])}</a></li>`
    )
    .join('');
  return `<div class="summary-box" role="alert"><h2>There is a problem with this step</h2><ul>${items}</ul></div>`;
}

const TRUST_C = `<div class="trust"><div><strong>Packed by hand</strong>Every order is wrapped in recycled paper.</div><div><strong>Fresh from the oven</strong>Baked goods ship within two days.</div><div><strong>Easy returns</strong>Tell us within 14 days if something is wrong.</div></div>`;

function formPageC(c, step) {
  const spec = SPECS.C;
  if (step === 'contact') {
    const content = `<p class="eyebrow">Step 1 of 3</p><h1>Who is this order for?</h1>${stepperC('contact')}${flashHtml('C', c.flash)}${summaryBoxC(c)}${bagC(c)}${TRUST_C}
<form method="post" action="${spec.routes.entry}" novalidate>
${textControl('C', c, 'firstName')}${textControl('C', c, 'lastName')}${textControl('C', c, 'email', 'email')}${textControl('C', c, 'phone', 'tel')}
<div class="nav-actions"><button class="go" type="submit">Save and continue</button><a class="back" href="/cart">Back to your bag</a></div>
</form>
<form method="post" action="${spec.routes.restart}" style="margin-top:22px"><button type="submit" class="plain">Start over</button></form>
${emptyCartForm('C')}`;
    return shell('C', c, { title: 'Your details', content });
  }
  const content = `<p class="eyebrow">Step 2 of 3</p><h1>Where should we deliver?</h1>${stepperC('address')}${flashHtml('C', c.flash)}${summaryBoxC(c)}${TRUST_C}
<form method="post" action="${spec.routes.address}" novalidate>
${textControl('C', c, 'line1')}${textControl('C', c, 'line2')}${textControl('C', c, 'city')}
${selectControl('C', c, 'country', countryOptions('C', c.values.country, 'Choose a country or territory'))}
${selectControl('C', c, 'region', regionOptions(c.values.region, 'Choose a state, province or region'))}
${textControl('C', c, 'postalCode')}
${deliveryControl('C', c)}
${checkControl('C', c, 'giftWrap')}${checkControl('C', c, 'saveAddress')}
<div class="nav-actions"><button class="go" type="submit">Save and continue</button><a class="back" href="${spec.routes.entry}">Back to your details</a></div>
</form>
<form method="post" action="${spec.routes.restart}" style="margin-top:22px"><button type="submit" class="plain">Start over</button></form>
${emptyCartForm('C')}`;
  return shell('C', c, { title: 'Delivery', content });
}

function reviewModel(variant, f) {
  const country = COUNTRY_BY_CODE.get(f.country);
  const region = regionLabel(f.country, f.region);
  const cityLine = [f.city, region].filter(Boolean).join(', ');
  const lines = [
    f.line1,
    f.line2,
    [cityLine, f.postalCode].filter(Boolean).join(' '),
    country?.name,
  ].filter(Boolean);
  const spec = SPECS[variant];
  const delivery = spec.delivery[f.delivery];
  return {
    name: `${f.firstName} ${f.lastName}`.trim() || '-',
    email: f.email || '-',
    phone: f.phone || 'Not provided',
    lines,
    deliveryTitle: delivery ? delivery[0] : '-',
    deliveryEta: delivery ? delivery[1] : '',
    deliveryPrice: delivery
      ? DELIVERY_CENTS[f.delivery] === 0
        ? 'Free'
        : money(DELIVERY_CENTS[f.delivery])
      : '-',
    gift: f.giftWrap ? 'Yes' : 'No',
    saved: f.saveAddress ? 'Yes' : 'No',
    totals: totals(variant, f),
  };
}

const addressHtml = lines =>
  lines.length ? `<address>${lines.map(esc).join('<br>')}</address>` : '<address>-</address>';

function reviewPage(variant, c) {
  const spec = SPECS[variant];
  const m = reviewModel(variant, c.fields);
  const t = m.totals;
  const pay = spec.routes.payment;
  if (variant === 'A') {
    const content = `<ol class="steps" aria-label="Checkout progress"><li><a href="/cart">Cart</a></li><li><a href="${spec.routes.entry}">Shipping</a></li><li aria-current="step">Review</li><li>Payment</li></ol>
<h1>Review your order</h1>${flashHtml('A', c.flash)}
<div class="cols"><div>
<section class="card" aria-labelledby="a-rc"><h2 id="a-rc">Contact</h2><dl class="review"><dt>Name</dt><dd>${esc(m.name)}</dd><dt>Email</dt><dd>${esc(m.email)}</dd><dt>Phone</dt><dd>${esc(m.phone)}</dd></dl></section>
<section class="card" aria-labelledby="a-rs"><h2 id="a-rs">Ship to</h2>${addressHtml(m.lines)}</section>
<section class="card" aria-labelledby="a-rd"><h2 id="a-rd">Delivery</h2><dl class="review"><dt>Method</dt><dd>${esc(m.deliveryTitle)}${m.deliveryEta ? `, ${esc(m.deliveryEta)}` : ''} (${m.deliveryPrice})</dd><dt>Gift wrap</dt><dd>${m.gift}</dd><dt>Save address</dt><dd>${m.saved}</dd></dl></section>
<div class="actions"><a class="btn primary" href="${pay}">Continue to payment</a><a href="${spec.routes.entry}">Edit shipping details</a></div>
</div>${summaryA(c, true)}</div>`;
    return shell('A', c, { title: 'Review your order', content });
  }
  if (variant === 'B') {
    const content = `<h1>Check your order</h1><p class="lede">Everything below is what we have on file for this delivery.</p>${flashHtml('B', c.flash)}
<section class="panel"><h2>Recipient</h2><dl class="kv"><dt>Name</dt><dd>${esc(m.name)}</dd><dt>E-mail</dt><dd>${esc(m.email)}</dd><dt>Mobile</dt><dd>${esc(m.phone)}</dd></dl></section>
<section class="panel"><h2>Delivery address</h2>${addressHtml(m.lines)}</section>
<section class="panel"><h2>Speed and extras</h2><dl class="kv"><dt>Delivery</dt><dd>${esc(m.deliveryTitle)}${m.deliveryEta ? `, ${esc(m.deliveryEta)}` : ''} (${m.deliveryPrice})</dd><dt>Gift wrapped</dt><dd>${m.gift}</dd><dt>Address remembered</dt><dd>${m.saved}</dd></dl></section>
<section class="panel"><h2>Totals</h2><table class="lines"><tbody><tr><td>Items</td><td>${money(t.subtotal)}</td></tr><tr><td>Delivery</td><td>${t.shipping === 0 ? 'Free' : money(t.shipping)}</td></tr>${t.gift ? `<tr><td>Gift wrap</td><td>${money(t.gift)}</td></tr>` : ''}<tr><th scope="row">Order total</th><th>${money(t.total)}</th></tr></tbody></table></section>
<div class="row-actions"><a class="cta" href="${pay}">Continue to payment</a><a href="${spec.routes.entry}">Change delivery details</a></div>
<form method="post" action="${spec.routes.discard}" style="margin-top:18px"><button type="submit" class="warn">Discard changes</button></form>${emptyCartForm('B')}`;
    return shell('B', c, { title: 'Order check', content });
  }
  const content = `<p class="eyebrow">Step 3 of 3</p><h1>Review and finish</h1>${stepperC('review')}${flashHtml('C', c.flash)}
<section class="rv" aria-labelledby="fh-rv-you"><h2 id="fh-rv-you">Your details</h2><a class="edit" href="${spec.routes.entry}">Edit details</a><dl><dt>Name</dt><dd>${esc(m.name)}</dd><dt>Contact email</dt><dd>${esc(m.email)}</dd><dt>Telephone</dt><dd>${esc(m.phone)}</dd></dl></section>
<section class="rv" aria-labelledby="fh-rv-ship"><h2 id="fh-rv-ship">Delivery</h2><a class="edit" href="${spec.routes.address}">Edit delivery</a><dl><dt>Deliver to</dt><dd>${addressHtml(m.lines)}</dd><dt>Shipping service</dt><dd>${esc(m.deliveryTitle)}${m.deliveryEta ? `, ${esc(m.deliveryEta)}` : ''} (${m.deliveryPrice})</dd><dt>Gift packaging</dt><dd>${m.gift}</dd><dt>Address book</dt><dd>${m.saved}</dd></dl></section>
<div class="bag"><h2>Totals</h2><div class="tot"><span>Items</span><span>${money(t.subtotal)}</span></div><div class="tot"><span>Shipping</span><span>${t.shipping === 0 ? 'Free' : money(t.shipping)}</span></div>${t.gift ? `<div class="tot"><span>Gift packaging</span><span>${money(t.gift)}</span></div>` : ''}<div class="tot grand"><span>Order total</span><span>${money(t.total)}</span></div></div>
<div class="nav-actions"><a class="go" href="${pay}">Continue to payment</a><a class="back" href="${spec.routes.address}">Back to delivery</a></div>
<form method="post" action="${spec.routes.restart}" style="margin-top:22px"><button type="submit" class="plain">Start over</button></form>`;
  return shell('C', c, { title: 'Review', content });
}

function simplePage(variant, c, title, body) {
  const heading = `<h1>${esc(title)}</h1>`;
  return shell(variant, c, { title, content: `${heading}${flashHtml(variant, c.flash)}${body}` });
}

function paymentPage(variant, c) {
  const spec = SPECS[variant];
  const back = spec.routes.review;
  return simplePage(
    variant,
    c,
    'Payment',
    `<p>The payment step has not been built yet. No order has been created for this basket.</p><p><a href="${back}">Back to review</a></p>`
  );
}

function cartPage(variant, c) {
  const spec = SPECS[variant];
  if (c.cartEmpty) {
    return simplePage(
      variant,
      c,
      'Your cart',
      `<p>Your cart is empty.</p><p><a href="/p/shop">Continue shopping</a></p>`
    );
  }
  const rows = ITEMS[variant]
    .map(
      item =>
        `<tr><td>${esc(item.name)}</td><td>${item.qty}</td><td>${money(item.cents)}</td><td>${money(item.qty * item.cents)}</td></tr>`
    )
    .join('');
  const sub = totals(variant, blankFields(variant)).subtotal;
  const checkoutLabel =
    variant === 'A'
      ? 'Proceed to checkout'
      : variant === 'B'
        ? 'Go to delivery details'
        : 'Begin checkout';
  const body = `<table class="items lines"><thead><tr><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">Price</th><th scope="col">Total</th></tr></thead><tbody>${rows}</tbody></table>
<p>Subtotal: <strong>${money(sub)}</strong></p>
<p><a class="btn primary cta go" href="${spec.routes.entry}">${checkoutLabel}</a> <a href="/p/shop">Continue shopping</a></p>`;
  return simplePage(variant, c, 'Your cart', body);
}

function subscribedPage(variant, c) {
  return simplePage(
    variant,
    c,
    'Thanks for subscribing',
    `<p>You are on the list. Watch your inbox for the next newsletter.</p><p><a href="${SPECS[variant].routes.entry}">Return to checkout</a></p>`
  );
}

function contentPage(variant, c, slug) {
  const [title, text] = CONTENT_PAGES[slug];
  const back = c.cartEmpty ? '/cart' : SPECS[variant].routes.entry;
  return simplePage(
    variant,
    c,
    title,
    `<p>${esc(text)}</p><p><a href="${back}">Back to checkout</a></p>`
  );
}

function searchPage(variant, c, q) {
  return simplePage(
    variant,
    c,
    'Search results',
    `<p>No products matched “${esc(q)}”.</p><p><a href="/p/shop">Browse everything</a></p>`
  );
}

function notFoundPage(variant, c) {
  return simplePage(
    variant,
    c,
    'Page not found',
    `<p>We could not find that page.</p><p><a href="/p/home">Go to the home page</a></p>`
  );
}

function serverErrorPage(variant, c) {
  return simplePage(
    variant,
    c,
    'Something went wrong',
    `<div class="${variant === 'A' ? 'banner' : variant === 'B' ? 'note' : 'flash'} error" role="alert">${esc(SPECS[variant].failure)}</div>`
  );
}

// ---------------------------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------------------------

function createBackend(variant, faults, initial) {
  const spec = SPECS[variant];
  const routes = spec.routes;
  let baseline = initial;
  let sessions;
  let sessionCounter;
  let lastSession;
  let seq;
  let requestLog;
  let submissions;
  let reviewViews;
  let paymentViews;
  let savedAddresses;
  let newsletter;
  let promoAttempts;
  let cartEmptied;
  let discards;
  const sleepers = new Set();

  const startingFields = () => ({ ...blankFields(variant), ...baseline });
  const freshSession = id => ({
    id,
    fields: startingFields(),
    steps: { contact: false, address: false },
    cartEmpty: false,
    flash: null,
  });

  function reset(next) {
    baseline = next === undefined ? initial : next;
    sessions = new Map();
    sessionCounter = 0;
    lastSession = null;
    seq = 0;
    requestLog = [];
    submissions = [];
    reviewViews = 0;
    paymentViews = 0;
    savedAddresses = [];
    newsletter = [];
    promoAttempts = [];
    cartEmptied = 0;
    discards = 0;
  }
  reset();

  function state() {
    const session = lastSession ?? freshSession('none');
    return clone({
      family,
      variant,
      draft: session.fields,
      steps: session.steps,
      cart: {
        lines: session.cartEmpty ? 0 : ITEMS[variant].length,
        units: session.cartEmpty ? 0 : cartUnits(variant),
        emptied: session.cartEmpty,
      },
      submissions,
      reviewViews,
      paymentViews,
      savedAddresses,
      newsletter,
      promoAttempts,
      cartEmptied,
      discards,
      sessions: sessions.size,
    });
  }

  const requests = () => clone(requestLog);

  function sleep(ms) {
    return new Promise(resolve => {
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        sleepers.delete(entry);
        resolve();
      }, ms);
      sleepers.add(entry);
    });
  }

  function dispose() {
    for (const entry of sleepers) {
      clearTimeout(entry.timer);
      entry.resolve();
    }
    sleepers.clear();
  }

  function parseCookies(header) {
    const out = {};
    for (const part of header.split(';')) {
      const index = part.indexOf('=');
      if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return out;
  }

  function resolveSession(cookieHeader) {
    const sid = parseCookies(cookieHeader).sid;
    const existing = sid ? sessions.get(sid) : undefined;
    if (existing) return { session: existing, created: false };
    sessionCounter += 1;
    const session = freshSession(`s${sessionCounter}`);
    sessions.set(session.id, session);
    return { session, created: true };
  }

  const summarizeBody = form => {
    const out = {};
    for (const [key, raw] of form.entries()) {
      const value = maskValue(key, raw);
      out[key] = value.length > 80 ? `${value.slice(0, 80)}...` : value;
    }
    return out;
  };

  const html = (status, body) => ({
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    body,
  });
  const redirect = (location, status = 303) => ({
    status,
    headers: { location, 'cache-control': 'no-store' },
    body: '',
  });

  const ready = session => session.steps.contact && session.steps.address;
  const firstIncomplete = session =>
    variant === 'C' && session.steps.contact && !session.steps.address
      ? routes.address
      : routes.entry;

  const safeBack = value => {
    const known = [routes.entry, routes.address, routes.review, routes.payment, '/cart'].filter(
      Boolean
    );
    return known.includes(value) ? value : '/cart';
  };

  function context(r, extra = {}) {
    const flash = r.session.flash;
    r.session.flash = null;
    return {
      path: r.path,
      faults,
      flash,
      fields: r.session.fields,
      cartEmpty: r.session.cartEmpty,
      values: r.session.fields,
      errors: [],
      messages: {},
      ...extra,
    };
  }

  function renderForm(r, step, extra = {}) {
    const c = context(r, extra);
    if (variant === 'A') return formPageA(c);
    if (variant === 'B') return formPageB(c);
    return formPageC(c, step);
  }

  const formDefs = {
    A: {
      [routes.entry]: {
        step: 'shipping',
        keys: [...CONTACT_KEYS, ...ADDRESS_KEYS],
        next: routes.review,
      },
    },
    B: {
      [routes.entry]: {
        step: 'delivery',
        keys: [...CONTACT_KEYS, ...ADDRESS_KEYS],
        next: routes.review,
      },
    },
    C: {
      [routes.entry]: { step: 'contact', keys: CONTACT_KEYS, next: routes.address },
      [routes.address ?? '']: { step: 'address', keys: ADDRESS_KEYS, next: routes.review },
    },
  }[variant];

  const record = (r, def, outcome, errors) =>
    submissions.push({
      seq: r.seq,
      step: def.step,
      accepted: outcome === 'accepted',
      outcome,
      errors,
    });

  function submitForm(r, def) {
    const session = r.session;
    const values = readForm(variant, r.form, def.keys);
    const errors = validate(variant, values, def.keys);
    const merged = { ...session.fields, ...values };
    if (errors.length > 0) {
      record(r, def, 'rejected', errors);
      return html(
        200,
        renderForm(r, def.step, {
          values: merged,
          errors,
          messages: errorMessages(variant, errors, merged),
        })
      );
    }
    if (faults.failWrites) {
      record(r, def, 'failed', []);
      return html(
        500,
        renderForm(r, def.step, {
          values: merged,
          flash: { kind: 'error', text: spec.failure },
        })
      );
    }
    session.flash = {
      kind: 'success',
      text: variant === 'C' ? spec.flash[def.step] : spec.flash.saved,
    };
    if (faults.misleadingSuccess) {
      record(r, def, 'dropped', []);
      return redirect(def.next);
    }
    const normalized = normalizeValues(values);
    session.fields = { ...session.fields, ...normalized };
    session.steps = {
      contact: session.steps.contact || def.keys.includes('firstName'),
      address: session.steps.address || def.keys.includes('line1'),
    };
    if (normalized.saveAddress === true) {
      const f = session.fields;
      const entry = {
        line1: f.line1,
        line2: f.line2,
        city: f.city,
        region: f.region,
        postalCode: f.postalCode,
        country: f.country,
      };
      const known = savedAddresses.some(a =>
        Object.keys(entry).every(key => a[key] === entry[key])
      );
      if (!known) savedAddresses.push({ seq: r.seq, ...entry });
    }
    record(r, def, 'accepted', []);
    return redirect(def.next);
  }

  function writeFailure(r) {
    return html(500, serverErrorPage(variant, context(r)));
  }

  function clearDraft(session) {
    session.fields = startingFields();
    session.steps = { contact: false, address: false };
  }

  function post(r) {
    const { path, session } = r;
    const def = formDefs[path];
    if (def) return submitForm(r, def);
    const isWrite = [
      '/cart/empty',
      '/promo',
      '/newsletter',
      routes.discard,
      routes.restart,
    ].includes(path);
    if (!isWrite) return html(404, notFoundPage(variant, context(r)));
    if (faults.failWrites) return writeFailure(r);
    if (path === '/cart/empty') {
      cartEmptied += 1;
      session.cartEmpty = true;
      clearDraft(session);
      return redirect('/cart');
    }
    if (path === '/promo') {
      const code = maskValue('code', (r.form.get('code') ?? '').trim());
      if (code) promoAttempts.push({ seq: r.seq, code });
      session.flash = code
        ? { kind: 'error', text: `The code “${code}” is not valid or has expired.` }
        : { kind: 'error', text: 'Enter a code first.' };
      return redirect(safeBack(r.form.get('back') ?? ''));
    }
    if (path === '/newsletter') {
      const email = (r.form.get('email') ?? '').trim();
      if (!email) {
        session.flash = { kind: 'error', text: 'Enter an email address to subscribe.' };
        return redirect(routes.entry);
      }
      newsletter.push({ seq: r.seq, email });
      return redirect('/subscribed');
    }
    discards += 1;
    clearDraft(session);
    session.flash = { kind: 'info', text: 'Your entries were discarded.' };
    return redirect(routes.entry);
  }

  function get(r) {
    const { path, session } = r;
    const query = r.query;
    const checkoutPaths = [routes.entry, routes.address, routes.review, routes.payment].filter(
      Boolean
    );
    if (path === '/') return redirect(routes.entry, 302);
    if (checkoutPaths.includes(path) && session.cartEmpty) return redirect('/cart');
    if (path === routes.entry) {
      const fresh = variant === 'A' && query.has('clear');
      return html(200, renderForm(r, 'contact', fresh ? { values: blankFields(variant) } : {}));
    }
    if (variant === 'C' && path === routes.address) {
      if (!session.steps.contact && !faults.misleadingSuccess) return redirect(routes.entry);
      return html(200, renderForm(r, 'address'));
    }
    if (path === routes.review) {
      if (!ready(session) && !faults.misleadingSuccess) return redirect(firstIncomplete(session));
      reviewViews += 1;
      return html(200, reviewPage(variant, context(r)));
    }
    if (path === routes.payment) {
      paymentViews += 1;
      return html(200, paymentPage(variant, context(r)));
    }
    if (path === '/cart') return html(200, cartPage(variant, context(r)));
    if (path === '/subscribed') return html(200, subscribedPage(variant, context(r)));
    if (path === '/search') return html(200, searchPage(variant, context(r), query.get('q') ?? ''));
    if (path.startsWith('/p/')) {
      const slug = path.slice(3);
      if (Object.hasOwn(CONTENT_PAGES, slug))
        return html(200, contentPage(variant, context(r), slug));
    }
    return html(404, notFoundPage(variant, context(r)));
  }

  function dispatch(method, url, cookieHeader, bodyText) {
    const form = method === 'POST' ? new URLSearchParams(bodyText) : new URLSearchParams();
    seq += 1;
    requestLog.push({
      seq,
      method,
      path: url.pathname,
      query: Object.fromEntries(
        [...url.searchParams].map(([key, value]) => [key, maskValue(key, value)])
      ),
      bodySummary: method === 'POST' ? summarizeBody(form) : null,
    });
    const { session, created } = resolveSession(cookieHeader);
    lastSession = session;
    const r = { method, path: url.pathname, query: url.searchParams, form, session, seq };
    const out = method === 'POST' ? post(r) : get(r);
    if (created) out.headers['set-cookie'] = `sid=${session.id}; Path=/; HttpOnly; SameSite=Lax`;
    return out;
  }

  return { dispatch, state, requests, reset, sleep, dispose };
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

const INITIAL_SUMMARIES = {
  firstName: 'Text already stored in the server draft for the first/given name field.',
  lastName: 'Text already stored in the draft for the last/family name field.',
  email: 'Email address already stored in the draft.',
  phone: 'Phone number already stored in the draft.',
  line1: 'Address line 1 already stored in the draft.',
  line2: 'Address line 2 already stored in the draft.',
  city: 'City already stored in the draft.',
  country:
    'Country code already selected (US, CA, GB, AU, DE, FR, IN; variant B offers only US, CA, GB) or "" for none.',
  region: 'State or province code already selected (for example CA, NY, ON) or "".',
  postalCode: 'Postal code already stored in the draft.',
  delivery: 'Delivery method already selected: standard, express, overnight or "" for none.',
  giftWrap: 'Boolean: gift wrap already ticked.',
  saveAddress: 'Boolean: save-this-address already ticked.',
};

export function describe() {
  return {
    family,
    variants: [
      {
        id: 'A',
        summary:
          'Single shipping page (Larkspur Home): one form with contact, address, delivery method and extras, POST then review page. Phone optional, country select, delivery preselected to the standard option.',
      },
      {
        id: 'B',
        summary:
          'Tidewater Outfitters: different labels and section order, country as a radio list of three countries, state select, phone required, delivery speed cards with nothing preselected.',
      },
      {
        id: 'C',
        summary:
          'Fernhill Market: three-step wizard (contact page, address page, review page) with three full navigations, Back links, country not preselected, long pages so the primary action needs scrolling.',
      },
    ],
    faults: [
      {
        name: 'rerenderEveryMs',
        summary:
          'Every N ms the main content is replaced by freshly built equivalent nodes (entered values and focus are carried over) so held element references go stale.',
      },
      {
        name: 'slowResponseMs',
        summary:
          'Every page and form response (everything except /__test endpoints) is delayed by N ms; the server still processes the request immediately.',
      },
      {
        name: 'failWrites',
        summary:
          'Every write (form POSTs, discard, promo, newsletter, empty cart) returns HTTP 500 with a visible error and persists nothing; form POSTs re-render with the entered values.',
      },
      {
        name: 'misleadingSuccess',
        summary:
          'Valid submissions show the normal saved banner and move to the next page but are silently dropped: the backend draft is not updated and the review page prints the stale draft.',
      },
    ],
    initialOptions: DRAFT_KEYS.map(name => ({ name, summary: INITIAL_SUMMARIES[name] })),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 256 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

export async function startApp({ port = 0, variant = 'A', initial = {}, faults = {} } = {}) {
  if (!variants.includes(variant)) {
    throw new RangeError(`unknown variant "${variant}" (known: ${variants.join(', ')})`);
  }
  const fault = normalizeFaults(faults);
  const backend = createBackend(variant, fault, normalizeInitial(initial, variant));

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    if (url.pathname === '/__test/state' && method === 'GET')
      return sendJson(res, 200, backend.state());
    if (url.pathname === '/__test/reset' && method === 'POST') {
      const text = await readBody(req);
      let next;
      try {
        const parsed = text.trim() ? JSON.parse(text) : {};
        next = parsed.initial === undefined ? undefined : normalizeInitial(parsed.initial, variant);
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error.message ?? error) });
      }
      backend.reset(next);
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (method !== 'GET' && method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST' });
      res.end();
      return;
    }
    const bodyText = method === 'POST' ? await readBody(req) : '';
    const out = backend.dispatch(method, url, req.headers.cookie ?? '', bodyText);
    if (fault.slowResponseMs > 0) await backend.sleep(fault.slowResponseMs);
    if (res.destroyed) return;
    res.writeHead(out.status, out.headers);
    res.end(out.body);
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  let closing = null;
  const close = () => {
    if (!closing) {
      backend.dispose();
      closing = new Promise(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
    return closing;
  };

  return {
    url: `${origin}/`,
    origin,
    family,
    variant,
    state: () => backend.state(),
    requests: () => backend.requests(),
    reset: next => backend.reset(next === undefined ? undefined : normalizeInitial(next, variant)),
    close,
  };
}
