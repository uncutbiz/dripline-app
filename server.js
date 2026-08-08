require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const twilio = require('twilio');
const nodemailer = require('nodemailer');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production';
const SUCCESS_URL = process.env.SUCCESS_URL || 'https://your-site.com/booking-confirmed';
const CANCEL_URL = process.env.CANCEL_URL || 'https://your-site.com/booking-cancelled';
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-this-admin-key';

const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;

// FREE SMS option: every major US carrier lets you text a phone by emailing
// number@their-gateway-domain. No per-message cost, just needs an email account
// to send from (a free Gmail account + "app password" works fine).
const CARRIER_GATEWAYS = {
  att: 'txt.att.net',
  verizon: 'vtext.com',
  tmobile: 'tmomail.net',
  sprint: 'messaging.sprintpcs.com',
  boost: 'sms.myboostmobile.com',
  cricket: 'sms.cricketwireless.net',
  metropcs: 'mymetropcs.com',
  uscellular: 'email.uscc.net',
  googlefi: 'msg.fi.google.com',
};

const emailTransporter = (process.env.SMS_EMAIL_USER && process.env.SMS_EMAIL_PASS)
  ? nodemailer.createTransport({
      service: process.env.SMS_EMAIL_SERVICE || 'gmail',
      auth: { user: process.env.SMS_EMAIL_USER, pass: process.env.SMS_EMAIL_PASS },
    })
  : null;

function sendFreeSms(nurse, message) {
  if (!emailTransporter) return false;
  if (!nurse.carrier || !CARRIER_GATEWAYS[nurse.carrier]) {
    console.warn(`Nurse ${nurse.name} has no valid carrier set — can't send free SMS. Set nurse.carrier to one of: ${Object.keys(CARRIER_GATEWAYS).join(', ')}`);
    return false;
  }
  const digits = nurse.phone.replace(/\D/g, '').slice(-10); // last 10 digits, gateways don't want +1
  const to = `${digits}@${CARRIER_GATEWAYS[nurse.carrier]}`;

  emailTransporter.sendMail({
    from: process.env.SMS_EMAIL_USER,
    to,
    subject: '', // carrier gateways generally ignore/strip the subject
    text: message,
  }).then(() => console.log(`Free SMS sent to ${nurse.name} via ${nurse.carrier} gateway`))
    .catch((err) => console.error('Free SMS send failed:', err.message));

  return true;
}

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_BASE = process.env.PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com'; // sandbox by default until you flip PAYPAL_ENV=live

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// ---------- AUTH ----------

app.post('/register', async (req, res) => {
  const { name, email, password, phone } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required' });
  }

  const users = db.getUsers();
  if (users.find((u) => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: 'u_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
    name,
    email,
    phone: phone || '',
    passwordHash,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  db.saveUsers(users);

  const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const users = db.getUsers();
  const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Invalid email or password' });

  const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

// Optional auth: attaches req.user if a valid token is present, but doesn't block guest checkout
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(header.slice(7), JWT_SECRET);
    } catch (err) {
      // invalid/expired token — proceed as a guest rather than blocking checkout
    }
  }
  next();
}

// Fixed, transparent nurse payouts per package — separate from partner/referral fees,
// which come out of DRIPLINE's margin, not the nurse's cut. Nurses always know this
// number before accepting, regardless of how the booking arrived (referral, membership, direct).
const NURSE_PAYOUTS = {
  'Hydration': 65,
  'Myers Cocktail': 95,
  "Myers' Cocktail": 95,
  'Deluxe Myers': 115,
  "Deluxe Myers'": 115,
  'Elite All-In': 135,
  'Vegas Recovery Package': 85,
  'Solo Membership': 70,
  'Couples Membership': 110,
  'Squad Membership': 220,
};
const DEFAULT_NURSE_PAYOUT = 80; // fallback for any package not in the table above

function payoutForPackage(pkgLabel) {
  return NURSE_PAYOUTS[pkgLabel] || DEFAULT_NURSE_PAYOUT;
}

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Invalid admin key' });
  next();
}

// Broadcasts a booking offer to every active nurse in that city, showing the payout
// upfront — nobody gets auto-assigned. Whoever accepts first (via the nurse portal)
// gets it, so nurses can browse open offers and pick what fits their schedule,
// including accepting more than one if their schedule allows.
function offerBookingToNurses(booking) {
  const nurses = db.getNurses();
  const eligible = nurses.filter((n) => n.active && n.city === booking.city);

  if (eligible.length === 0) {
    console.warn(`No active nurse available in ${booking.city} for booking ${booking.id}`);
    return [];
  }

  const bookings = db.getBookings();
  const b = bookings.find((x) => x.id === booking.id);
  if (b) {
    b.status = 'offered';
    b.nursePayout = payoutForPackage(booking.package);
    b.offeredAt = new Date().toISOString();
    b.declinedBy = b.declinedBy || [];
    db.saveBookings(bookings);
  }

  const payout = b ? b.nursePayout : payoutForPackage(booking.package);
  const message = `DRIPLINE: New ${booking.package} booking in ${booking.city}. You'd earn $${payout}. Open the nurse portal to accept: ${process.env.NURSE_PORTAL_URL || '(ask your admin for the portal link)'}`;

  eligible.forEach((nurse) => {
    const sentFree = sendFreeSms(nurse, message);
    if (!sentFree && twilioClient && TWILIO_FROM) {
      twilioClient.messages
        .create({ to: nurse.phone, from: TWILIO_FROM, body: message })
        .then(() => console.log(`Offer SMS sent via Twilio to ${nurse.name} for booking ${booking.id}`))
        .catch((err) => console.error('Failed to send offer SMS via Twilio:', err.message));
    } else if (!sentFree) {
      console.log(`[No SMS method configured] Would have offered ${nurse.name} (${nurse.phone}) booking ${booking.id} for $${payout}`);
    }
  });

  return eligible;
}

// ---------- NURSES (admin only) ----------

app.get('/nurses', requireAdmin, (req, res) => {
  res.json({ nurses: db.getNurses() });
});

app.post('/nurses', requireAdmin, (req, res) => {
  const { name, phone, city, carrier } = req.body;
  if (!name || !phone || !city) return res.status(400).json({ error: 'name, phone, and city are required' });

  const nurses = db.getNurses();
  const nurse = {
    id: 'n_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
    name, phone, city,
    carrier: carrier || null,
    pin: String(Math.floor(1000 + Math.random() * 9000)), // 4-digit PIN for the nurse portal — shown once here, admin should relay it to the nurse
    active: true,
    lastDispatchedAt: null,
    createdAt: new Date().toISOString(),
  };
  nurses.push(nurse);
  db.saveNurses(nurses);
  res.json({ nurse });
});

app.patch('/nurses/:id', requireAdmin, (req, res) => {
  const nurses = db.getNurses();
  const nurse = nurses.find((n) => n.id === req.params.id);
  if (!nurse) return res.status(404).json({ error: 'Nurse not found' });

  if (typeof req.body.active === 'boolean') nurse.active = req.body.active;
  if (req.body.city) nurse.city = req.body.city;
  db.saveNurses(nurses);
  res.json({ nurse });
});

// ---------- NURSE PORTAL ----------
// Lightweight auth for nurses (phone + PIN, no email/password needed) — separate from
// customer accounts and separate from the admin key.

app.post('/nurse-login', (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) return res.status(400).json({ error: 'phone and pin are required' });

  const nurses = db.getNurses();
  const nurse = nurses.find((n) => n.phone === phone && n.pin === String(pin));
  if (!nurse) return res.status(401).json({ error: 'Phone or PIN not recognized' });

  const token = jwt.sign({ nurseId: nurse.id, role: 'nurse' }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, nurse: { id: nurse.id, name: nurse.name, city: nurse.city } });
});

function requireNurse(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Not logged in' });
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    if (payload.role !== 'nurse') throw new Error('wrong role');
    req.nurseId = payload.nurseId;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// Shows every open offer in the nurse's city they haven't already declined, PLUS
// their own already-accepted upcoming bookings — so they can browse and pick
// what fits their schedule rather than being forced into one at a time.
app.get('/nurse-offers', requireNurse, (req, res) => {
  const nurses = db.getNurses();
  const nurse = nurses.find((n) => n.id === req.nurseId);
  if (!nurse) return res.status(404).json({ error: 'Nurse not found' });

  const bookings = db.getBookings();
  const openOffers = bookings.filter((b) =>
    b.status === 'offered' &&
    b.city === nurse.city &&
    !(b.declinedBy || []).includes(nurse.id)
  );
  const myUpcoming = bookings.filter((b) =>
    b.nurseId === nurse.id && ['assigned', 'en_route'].includes(b.status)
  );

  res.json({ openOffers, myUpcoming, nurse: { name: nurse.name, city: nurse.city } });
});

// First nurse to accept gets it — booking must still be in "offered" status.
app.post('/nurse-offers/:bookingId/accept', requireNurse, (req, res) => {
  const bookings = db.getBookings();
  const booking = bookings.find((b) => b.id === req.params.bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'offered') {
    return res.status(409).json({ error: 'This booking was already taken by another nurse' });
  }

  const nurses = db.getNurses();
  const nurse = nurses.find((n) => n.id === req.nurseId);

  booking.nurseId = req.nurseId;
  booking.status = 'assigned';
  booking.acceptedAt = new Date().toISOString();
  db.saveBookings(bookings);

  if (nurse) {
    nurse.lastDispatchedAt = new Date().toISOString();
    db.saveNurses(nurses);
  }

  res.json({ booking });
});

// Declining just hides this offer from that nurse — it stays open for everyone else.
app.post('/nurse-offers/:bookingId/decline', requireNurse, (req, res) => {
  const bookings = db.getBookings();
  const booking = bookings.find((b) => b.id === req.params.bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  booking.declinedBy = booking.declinedBy || [];
  if (!booking.declinedBy.includes(req.nurseId)) booking.declinedBy.push(req.nurseId);
  db.saveBookings(bookings);

  res.json({ ok: true });
});

// ---------- BOOKINGS ADMIN VIEW ----------

app.get('/admin/bookings', requireAdmin, (req, res) => {
  const bookings = db.getBookings().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ bookings });
});

app.patch('/admin/bookings/:id', requireAdmin, (req, res) => {
  const bookings = db.getBookings();
  const booking = bookings.find((b) => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  if (req.body.status) booking.status = req.body.status;
  db.saveBookings(bookings);
  res.json({ booking });
});

// ---------- TEXT-TO-SPEECH (real human voice) ----------
// Tries Google Cloud TTS first (generous free tier — ~1M characters/month on
// standard voices), falls back to ElevenLabs if configured, falls back to the
// browser's built-in voice on the front-end if neither backend option works.
// API keys stay server-side here — never exposed in front-end code.
const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // "Rachel" — a default ElevenLabs voice

// Google Cloud TTS doesn't officially support Haitian Creole — falls through to
// English pronunciation of the Creole text if selected, which will sound off.
// Flagging honestly rather than silently producing bad audio with no explanation.
const GOOGLE_VOICE_MAP = {
  en: { languageCode: 'en-US', name: 'en-US-Neural2-F' },
  es: { languageCode: 'es-US', name: 'es-US-Neural2-A' },
  fr: { languageCode: 'fr-FR', name: 'fr-FR-Neural2-A' },
  pt: { languageCode: 'pt-BR', name: 'pt-BR-Neural2-A' },
  ht: { languageCode: 'en-US', name: 'en-US-Neural2-F' }, // no native Creole voice available — honest fallback
};

async function synthesizeGoogle(text, lang) {
  if (!GOOGLE_TTS_API_KEY) return null;
  const voice = GOOGLE_VOICE_MAP[lang] || GOOGLE_VOICE_MAP.en;

  const resp = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: voice.languageCode, name: voice.name },
      audioConfig: { audioEncoding: 'MP3' },
    }),
  });

  if (!resp.ok) {
    console.error('Google TTS error:', resp.status, await resp.text());
    return null;
  }
  const data = await resp.json();
  return Buffer.from(data.audioContent, 'base64'); // Google returns base64-encoded MP3
}

async function synthesizeElevenLabs(text) {
  if (!ELEVENLABS_API_KEY) return null;

  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!resp.ok) {
    console.error('ElevenLabs error:', resp.status, await resp.text());
    return null;
  }
  return Buffer.from(await resp.arrayBuffer());
}

app.post('/tts', async (req, res) => {
  const { text, lang } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  try {
    let audio = await synthesizeGoogle(text, lang || 'en');
    if (!audio) audio = await synthesizeElevenLabs(text);

    if (!audio) {
      return res.status(503).json({ error: 'No voice provider configured or all providers failed' });
    }

    res.set('Content-Type', 'audio/mpeg');
    res.send(audio);
  } catch (err) {
    console.error('TTS proxy error:', err);
    res.status(500).json({ error: 'Failed to generate voice' });
  }
});

// ---------- STATS (real persistence — replaces the earlier artifact-only storage) ----------

app.get('/stats', (req, res) => {
  const stats = db.getStats();
  if (stats.date !== todayKey()) {
    const reset = { total: 0, count: 0, date: todayKey() };
    db.saveStats(reset);
    return res.json(reset);
  }
  res.json(stats);
});

function incrementStats(amount) {
  const stats = db.getStats();
  const current = stats.date === todayKey() ? stats : { total: 0, count: 0, date: todayKey() };
  current.total += amount;
  current.count += 1;
  db.saveStats(current);
  return current;
}

// ---------- BOOKINGS ----------

app.post('/bookings', optionalAuth, (req, res) => {
  const { name, email, phone, city, package: pkg, total, paymentMethod, referralCode } = req.body;
  if (!name || !total) return res.status(400).json({ error: 'name and total are required' });

  // Look up the partner by code, if one was entered. Invalid/typo'd codes are stored
  // as-is for later review, but don't block checkout or attach a fee.
  let partnerId = null;
  let partnerFeeOwed = 0;
  if (referralCode) {
    const partners = db.getPartners();
    const partner = partners.find(
      (p) => p.active && p.code.toLowerCase() === String(referralCode).toLowerCase()
    );
    if (partner) {
      partnerId = partner.id;
      partnerFeeOwed = partner.feeType === 'percent'
        ? Math.round((total * partner.feeAmount) / 100 * 100) / 100
        : partner.feeAmount;
    }
  }

  const bookings = db.getBookings();
  const booking = {
    id: 'b_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
    userId: req.user ? req.user.id : null,
    name, email, phone, city,
    package: pkg,
    total,
    paymentMethod: paymentMethod || 'unspecified',
    referralCode: referralCode || null,
    partnerId,
    partnerFeeOwed,
    partnerFeePaid: false,
    paid: false,
    createdAt: new Date().toISOString(),
  };
  bookings.push(booking);
  db.saveBookings(bookings);

  res.json({ booking });
});

// ---------- PARTNERS (admin only) ----------

app.get('/partners', requireAdmin, (req, res) => {
  const partners = db.getPartners();
  const bookings = db.getBookings();

  // Attach live totals so the admin dashboard can show exactly what's owed to each partner
  const withTotals = partners.map((p) => {
    const theirBookings = bookings.filter((b) => b.partnerId === p.id && b.paid);
    const totalOwed = theirBookings
      .filter((b) => !b.partnerFeePaid)
      .reduce((sum, b) => sum + (b.partnerFeeOwed || 0), 0);
    const totalPaidOut = theirBookings
      .filter((b) => b.partnerFeePaid)
      .reduce((sum, b) => sum + (b.partnerFeeOwed || 0), 0);
    return { ...p, bookingsSent: theirBookings.length, totalOwed, totalPaidOut };
  });

  res.json({ partners: withTotals });
});

app.post('/partners', requireAdmin, (req, res) => {
  const { name, businessName, code, feeType, feeAmount, city } = req.body;
  if (!name || !code || !feeAmount) {
    return res.status(400).json({ error: 'name, code, and feeAmount are required' });
  }

  const partners = db.getPartners();
  if (partners.find((p) => p.code.toLowerCase() === code.toLowerCase())) {
    return res.status(409).json({ error: 'That referral code is already in use' });
  }

  const partner = {
    id: 'p_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
    name,
    businessName: businessName || '',
    code: code.toUpperCase(),
    feeType: feeType === 'percent' ? 'percent' : 'flat', // 'flat' dollar amount or 'percent' of booking total
    feeAmount: Number(feeAmount),
    city: city || '',
    active: true,
    createdAt: new Date().toISOString(),
  };
  partners.push(partner);
  db.savePartners(partners);
  res.json({ partner });
});

app.patch('/partners/:id', requireAdmin, (req, res) => {
  const partners = db.getPartners();
  const partner = partners.find((p) => p.id === req.params.id);
  if (!partner) return res.status(404).json({ error: 'Partner not found' });

  if (typeof req.body.active === 'boolean') partner.active = req.body.active;
  db.savePartners(partners);
  res.json({ partner });
});

// Marks all of a partner's currently-owed fees as paid out — use this after you've
// actually sent them their money (bank transfer, check, whatever), to reset the running total.
app.post('/partners/:id/mark-paid', requireAdmin, (req, res) => {
  const bookings = db.getBookings();
  bookings.forEach((b) => {
    if (b.partnerId === req.params.id && b.paid && !b.partnerFeePaid) {
      b.partnerFeePaid = true;
    }
  });
  db.saveBookings(bookings);
  res.json({ ok: true });
});

function markBookingPaid(bookingId) {
  const bookings = db.getBookings();
  const booking = bookings.find((b) => b.id === bookingId);
  if (booking && !booking.paid) {
    booking.paid = true;
    booking.status = 'paid';
    db.saveBookings(bookings);
    incrementStats(booking.total);
    offerBookingToNurses(booking); // broadcasts to all eligible nurses in that city, payout shown upfront
  }
  return booking;
}

// ---------- STRIPE ----------

app.post('/create-checkout-session', async (req, res) => {
  const { description, amount, customerName, customerEmail, bookingId } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      // Card + Cash App Pay explicitly. Apple Pay / Google Pay appear automatically
      // for eligible browsers/devices once you enable them in the Stripe Dashboard —
      // no extra code needed here for those two.
      payment_method_types: ['card', 'cashapp'],
      customer_email: customerEmail || undefined,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: description || 'DRIPLINE IV Service' },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      success_url: `${SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: CANCEL_URL,
      metadata: { customerName: customerName || 'unknown', bookingId: bookingId || '' },
    });
    res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('Stripe error creating session:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.sendStatus(400);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const bookingId = session.metadata && session.metadata.bookingId;
    if (bookingId) markBookingPaid(bookingId);
    console.log(`Stripe payment confirmed: ${session.id} — $${session.amount_total / 100}`);
  }

  res.sendStatus(200);
});

// ---------- PAYPAL ----------

async function getPayPalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const resp = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await resp.json();
  return data.access_token;
}

app.post('/create-paypal-order', async (req, res) => {
  const { amount, bookingId, returnUrl, cancelUrl } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    return res.status(500).json({ error: 'PayPal is not configured on this server yet' });
  }

  try {
    const accessToken = await getPayPalAccessToken();
    const resp = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: bookingId || 'dripline-booking',
            amount: { currency_code: 'USD', value: amount.toFixed(2) },
          },
        ],
        application_context: {
          return_url: returnUrl || SUCCESS_URL,
          cancel_url: cancelUrl || CANCEL_URL,
          user_action: 'PAY_NOW',
        },
      }),
    });
    const order = await resp.json();
    const approveLink = (order.links || []).find((l) => l.rel === 'approve');
    res.json({ id: order.id, approveUrl: approveLink ? approveLink.href : null });
  } catch (err) {
    console.error('PayPal order error:', err);
    res.status(500).json({ error: 'Failed to create PayPal order' });
  }
});

app.post('/capture-paypal-order/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const { bookingId } = req.body;
  try {
    const accessToken = await getPayPalAccessToken();
    const resp = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    const capture = await resp.json();

    if (capture.status === 'COMPLETED' && bookingId) {
      markBookingPaid(bookingId);
    }
    res.json(capture);
  } catch (err) {
    console.error('PayPal capture error:', err);
    res.status(500).json({ error: 'Failed to capture PayPal payment' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`DRIPLINE backend running on port ${PORT}`));
