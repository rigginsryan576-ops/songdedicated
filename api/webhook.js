// api/webhook.js
// Stripe calls this when payment succeeds.
// Triggers: Claude lyrics → MusicAPI audio → Resend email

import Stripe from 'stripe';
import Anthropic from '@anthropic-ai/sdk';
import { Resend } from 'resend';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);
const MUSICAPI_KEY = process.env.MUSICAPI_KEY;

// Vercel requires raw body for Stripe webhook verification
export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Only act on successful payments
  if (event.type !== 'payment_intent.succeeded') return res.json({ received: true });

  const pi = event.data.object;
  const meta = pi.metadata;

  const fullStory = (meta.story || '') + (meta.story_overflow || '');
  const email = meta.buyer_email;
  const recipient = meta.recipient;
  const occasion = meta.occasion;
  const genre = meta.genre || 'Pop';
  const mustInclude = meta.must_include || '';

  // Respond to Stripe immediately — song generation happens async
  res.json({ received: true });

  // ── NTFY PUSH NOTIFICATION ──
  await sendNtfyAlert(recipient, occasion, genre, email);

  // ── STEP 1: Generate lyrics with Claude ──
  let lyrics = '';
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `You are a professional hit songwriter. Write a complete, emotionally powerful ${genre} song for a ${occasion}.

ABOUT THE RECIPIENT: ${fullStory}
${mustInclude ? `MUST INCLUDE THESE PHRASES: ${mustInclude}` : ''}

Rules:
- Weave in specific personal details naturally — names, places, memories mentioned above
- Structure: [Verse 1] / [Chorus] / [Verse 2] / [Chorus] / [Bridge] / [Outro]
- Make it feel like it was written by someone who knows them deeply
- The chorus should be instantly memorable and singable
- Match the emotional tone of ${genre}
- Return ONLY the lyrics with section labels. No commentary.`
      }]
    });
    lyrics = msg.content[0].text;
  } catch (err) {
    console.error('Claude lyrics error:', err);
    await sendErrorEmail(resend, email, recipient);
    return;
  }

  // ── STEP 2: Generate audio with MusicAPI ──
  let audioUrl = '';
  try {
    // Submit generation job
    const genRes = await fetch('https://api.musicapi.ai/api/sonic/v1/generate', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MUSICAPI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customMode: true,
        instrumental: false,
        model: 'sonic-v4',
        title: `A Song for ${recipient}`,
        tags: buildTags(genre, occasion),
        prompt: lyrics,
      }),
    });

    const genData = await genRes.json();
    const taskId = genData?.data?.taskId || genData?.taskId;

    if (!taskId) throw new Error('No taskId from MusicAPI: ' + JSON.stringify(genData));

    // Poll for completion (up to 5 minutes)
    audioUrl = await pollMusicAPI(taskId);
  } catch (err) {
    console.error('MusicAPI error:', err);
    // Still send email with lyrics only as fallback
    await sendSongEmail(resend, email, recipient, occasion, lyrics, null);
    return;
  }

  // ── STEP 3: Email delivery via Resend ──
  await sendSongEmail(resend, email, recipient, occasion, lyrics, audioUrl);
}

// Poll MusicAPI until audio is ready
async function pollMusicAPI(taskId, maxAttempts = 60, intervalMs = 5000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    const res = await fetch(`https://api.musicapi.ai/api/sonic/v1/${taskId}`, {
      headers: { 'Authorization': `Bearer ${process.env.MUSICAPI_KEY}` }
    });
    const data = await res.json();
    const status = data?.data?.status || data?.status;
    const url = data?.data?.audio_url || data?.audio_url;

    if (status === 'complete' && url) return url;
    if (status === 'failed') throw new Error('MusicAPI generation failed');
  }
  throw new Error('MusicAPI timeout after 5 minutes');
}

function buildTags(genre, occasion) {
  const genreMap = {
    'Country': 'country, acoustic guitar, heartfelt, storytelling, Nashville',
    'Pop': 'pop, upbeat, polished, catchy hooks, studio quality',
    'R&B': 'rnb, soul, smooth vocals, emotional, melodic',
    'Hip-Hop': 'hip-hop, rap, modern beats, lyrical, personal',
    'Folk': 'folk, acoustic, intimate, fingerpicking, raw emotion',
    'Rock': 'rock, electric guitar, powerful, anthemic, drums',
  };
  const occasionMap = {
    'Anniversary': 'love song, romantic, tender',
    'Birthday': 'celebratory, joyful, warm',
    'Wedding / First Dance': 'romantic, slow, timeless',
    'In Memory / Tribute': 'tribute, emotional, gentle',
    'New Baby': 'tender, warm, hopeful',
    'Graduation': 'proud, triumphant, hopeful',
  };
  return [genreMap[genre] || genre, occasionMap[occasion] || ''].filter(Boolean).join(', ');
}

async function sendNtfyAlert(recipient, occasion, genre, email) {
  await fetch('https://ntfy.sh/rrtrades-edsgmcp79hktl38zv0jwfor2', {
    method: 'POST',
    headers: {
      'Title': '💰 New SongDedicated Order!',
      'Priority': 'high',
      'Tags': 'musical_note,moneybag',
      'Content-Type': 'text/plain',
    },
    body: `$99 order received\nSong for: ${recipient}\nOccasion: ${occasion}\nGenre: ${genre}\nCustomer: ${email}`,
  });
}

async function sendSongEmail(resend, email, recipient, occasion, lyrics, audioUrl) {
  const hasAudio = !!audioUrl;
  await resend.emails.send({
    from: 'SongDedicated <songs@songdedicated.com>',
    to: email,
    subject: `🎵 Your personalized song for ${recipient} is ready`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: Georgia, serif; background: #f7f2eb; margin: 0; padding: 0; }
  .wrap { max-width: 580px; margin: 0 auto; padding: 40px 20px; }
  .card { background: #fff; border-radius: 8px; padding: 40px; border: 1px solid #e2d9ce; }
  h1 { font-size: 28px; color: #1a1410; margin-bottom: 8px; }
  .gold { color: #c9963a; }
  p { color: #7a6e62; line-height: 1.7; margin: 12px 0; }
  .lyrics-box { background: #f7f2eb; border-left: 3px solid #c9963a; padding: 20px 24px; margin: 24px 0; border-radius: 4px; font-size: 15px; line-height: 1.9; color: #1a1410; white-space: pre-wrap; }
  .btn { display: inline-block; padding: 14px 32px; background: #1a1410; color: #f7f2eb; text-decoration: none; border-radius: 4px; font-family: Arial, sans-serif; font-weight: bold; font-size: 15px; margin: 8px 0; }
  .footer { text-align: center; margin-top: 32px; font-size: 12px; color: #a09080; }
</style></head>
<body>
<div class="wrap">
  <div class="card">
    <h1>🎵 Their song is <span class="gold">ready.</span></h1>
    <p>Your personalized ${occasion} song for <strong>${recipient}</strong> has been crafted just for them. We hope it makes them feel everything you meant it to.</p>
    ${hasAudio ? `<p style="text-align:center;margin:28px 0"><a href="${audioUrl}" class="btn">▶ Play Their Song</a></p><p style="text-align:center;font-size:13px;color:#a09080">Or <a href="${audioUrl}" style="color:#c9963a">download the MP3</a> to save it forever.</p>` : ''}
    <p><strong>The lyrics:</strong></p>
    <div class="lyrics-box">${lyrics.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
    <p style="font-size:13px">Questions? Reply to this email and we'll make it right.</p>
  </div>
  <div class="footer">© 2026 SongDedicated — The gift that plays forever</div>
</div>
</body>
</html>`,
  });
}

async function sendErrorEmail(resend, email, recipient) {
  await resend.emails.send({
    from: 'SongDedicated <songs@songdedicated.com>',
    to: email,
    subject: 'Your SongDedicated order — small delay',
    html: `<p>Hi there — we ran into a small technical hiccup generating the song for ${recipient}. Our team has been notified and will have it to you within a few hours. Sorry for the delay!</p>`,
  });
}
