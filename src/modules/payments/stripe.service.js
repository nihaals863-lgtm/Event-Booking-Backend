const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/**
 * Service to handle Stripe interactions
 */
const stripeService = {
    /**
     * Create a Stripe Checkout Session
     * @param {Object} data - session data
     */
    async createCheckoutSession({ orderId, eventTitle, ticketName, quantity, price, customerEmail, metadata }) {
        if (!process.env.STRIPE_SECRET_KEY) {
            throw new Error('STRIPE_SECRET_KEY is not configured in environment variables.');
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: customerEmail,
            line_items: [
                {
                    price_data: {
                        currency: 'aud', // Migrated from INR to AUD
                        product_data: {
                            name: `${eventTitle} - ${ticketName}`,
                            description: `Order ID: ${orderId}`,
                        },
                        unit_amount: price, // Now directly passing cents from backend
                    },
                    quantity: quantity,
                },
            ],
            mode: 'payment',
            metadata: {
                ...metadata,
                orderId
            },
            payment_intent_data: {
                metadata: {
                    ...metadata,
                    orderId
                }
            },
            success_url: `${process.env.FRONTEND_URL}/order-success?session_id={CHECKOUT_SESSION_ID}&order_id=${orderId}`,
            cancel_url: `${process.env.FRONTEND_URL}/events/${metadata.eventId}`,
            expires_at: Math.floor(Date.now() / 1000) + (30 * 60) // Expire in 30 minutes
        });

        return session;
    },

    /**
     * Retrieve a Stripe Checkout Session
     */
    async getSession(sessionId) {
        return await stripe.checkout.sessions.retrieve(sessionId);
    },

    /**
     * Retrieve a Stripe Payment Intent
     */
    async getPaymentIntent(paymentIntentId) {
        return await stripe.paymentIntents.retrieve(paymentIntentId);
    },

    /**
     * Construct a webhook event and verify signature
     */
    constructEvent(payload, signature) {
        if (!process.env.STRIPE_WEBHOOK_SECRET) {
            throw new Error('STRIPE_WEBHOOK_SECRET is missing.');
        }
        return stripe.webhooks.constructEvent(
            payload,
            signature,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    }
};

module.exports = stripeService;
