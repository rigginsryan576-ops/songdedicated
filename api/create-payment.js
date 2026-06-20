// api/create-payment.js
// Called when customer clicks "Create My Song — $99"
// Returns a Stripe clientSecret to confirm payment on the frontend

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { name, email, recipient, occasion, story, genre, mustInclude } = req.body;

  if (!email || !story || story.length < 20) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Store order metadata on the PaymentIntent so the webhook can access it
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 9900, // $99.00 in cents
      currency: 'usd',
      receipt_email: email,
      metadata: {
        buyer_name: name,
        buyer_email: email,
        recipient,
        occasion,
        genre,
        must_include: mustInclude || '',
        story: story.slice(0, 450), // Stripe metadata limit 500 chars per value
        story_overflow: story.slice(450, 900),
      },
      description: `SongDedicated — ${occasion} song for ${recipient}`,
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Payment setup failed' });
  }
}
