const prisma = require('../../config/db');
const stripeService = require('./stripe.service');
const crypto = require('crypto');

/**
 * Initiate a checkout session with atomic ticket locking
 */
const createCheckoutSession = async (req, res) => {
    const { eventId, quantity, attendeeName, attendeeEmail, ticketReleaseId } = req.body;
    const userId = req.user?.id || null;

    if (!eventId || !quantity || !attendeeName || !attendeeEmail) {
        return res.status(400).json({ error: 'Missing required purchase details' });
    }

    try {
        const eventIdInt = parseInt(eventId);
        const ticketReleaseIdInt = ticketReleaseId ? parseInt(ticketReleaseId) : null;
        const qtyInt = parseInt(quantity);

        // ATOMIC TRANSACTION: Phase 1 (Reserve Capacity)
        const result = await prisma.$transaction(async (tx) => {
            const event = await tx.event.findUnique({
                where: { id: eventIdInt },
                include: { ticketrelease: { where: { id: ticketReleaseIdInt || -1 } } }
            });

            if (!event) throw new Error('Event not found');
            if (event.status !== 'APPROVED') throw new Error('Event is not open for sales');

            let release = null;
            if (event.pricingType === 'MULTI') {
                release = event.ticketrelease[0];
                if (!release || !release.isActive) throw new Error('Selected ticket tier is unavailable');
            }

            // Calculate Active (Unexpired) Reservations
            const reservations = await tx.purchaseorder.aggregate({
                where: {
                    eventId: eventIdInt,
                    ticketReleaseId: ticketReleaseIdInt,
                    paymentStatus: 'PENDING',
                    expiresAt: { gt: new Date() }
                },
                _sum: { quantity: true }
            });

            const currentReserved = reservations._sum.quantity || 0;
            const currentSold = release ? release.sold : event.ticketsSold;
            const capacity = release ? release.quantity : event.totalTickets;

            if (currentSold + currentReserved + qtyInt > capacity) {
                console.warn(`[TICKET_LOCKED] Capacity full: sold=${currentSold} reserved=${currentReserved} trying=${qtyInt} max=${capacity}`);
                throw new Error('Tickets are temporarily held. Please try again in 5 minutes.');
            }

            // Calculation Logic
            const unitPrice = release ? release.price : event.ticketPrice;
            const subtotal = unitPrice * qtyInt;
            const settings = await tx.platformsettings.findFirst() || { platformFeeRate: 0.015, platformFeeFixed: 0.30, platformFeeFixedCents: 30 };
            const fee = (unitPrice === 0 || event.serviceFeeType !== 'BUYER') ? 0 : parseFloat(((subtotal * settings.platformFeeRate) + (settings.platformFeeFixed * qtyInt)).toFixed(2));
            const finalTotal = subtotal + fee;
            
            // DUAL-WRITE: Calculate cents for future migration
            const finalTotalCents = Math.round(finalTotal * 100);

            // Create Locked Order
            const orderId = `ORD-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
            const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30m lock (matches Stripe)

            const order = await tx.purchaseorder.create({
                data: {
                    id: orderId,
                    eventId: eventIdInt,
                    ticketReleaseId: ticketReleaseIdInt,
                    quantity: qtyInt,
                    amount: finalTotal,
                    amountCents: finalTotalCents, // New field
                    customerEmail: attendeeEmail,
                    customerName: attendeeName,
                    userId: userId,
                    paymentStatus: 'PENDING',
                    expiresAt,
                    status: 'PENDING'
                }
            });

            console.log(`[PAYMENT_LOCKED] orderId=${orderId} qty=${qtyInt} expires=${expiresAt.toISOString()}`);
            return { order, eventTitle: event.title, ticketName: release ? release.name : 'General Admission' };
        });

        // External Call: Phase 2 (Stripe Session)
        const session = await stripeService.createCheckoutSession({
            orderId: result.order.id,
            eventTitle: result.eventTitle,
            ticketName: result.ticketName,
            quantity: 1, // Fix: amountCents is ALREADY (unit_price * qty + fees). Do not multiply again.
            price: result.order.amountCents,
            customerEmail: attendeeEmail,
            mode: 'payment',
            metadata: {
                eventId: eventId.toString(),
                ticketReleaseId: ticketReleaseId ? ticketReleaseId.toString() : 'null',
                userId: userId ? userId.toString() : 'null',
                quantity: quantity.toString(),
                amountCents: result.order.amountCents.toString(),
                orderId: result.order.id
            },
            payment_intent_data: {
                metadata: {
                    eventId: eventId.toString(),
                    ticketReleaseId: ticketReleaseId ? ticketReleaseId.toString() : 'null',
                    userId: userId ? userId.toString() : 'null',
                    quantity: quantity.toString(),
                    amountCents: result.order.amountCents.toString(),
                    orderId: result.order.id
                }
            },
            success_url: `${process.env.FRONTEND_URL}/order-success?session_id={CHECKOUT_SESSION_ID}&order_id=${result.order.id}`,
        });

        // Link Session & Update Status to PAYMENT_PENDING
        await prisma.purchaseorder.update({
            where: { id: result.order.id },
            data: { 
                stripeSessionId: session.id,
                paymentStatus: 'PAYMENT_PENDING' 
            }
        });

        console.log(`[PAYMENT_SESSION_CREATED] orderId=${result.order.id} sessionId=${session.id}`);
        console.log(`[PAYMENT_PENDING] orderId=${result.order.id}`);
        res.json({ checkoutUrl: session.url, orderId: result.order.id });

    } catch (error) {
        console.error(`[PAYMENT_FAILED] Initiation: ${error.message}`);
        res.status(400).json({ error: error.message });
    }
};

/**
 * Get the status of an order (Polling for frontend)
 */
const getOrderStatus = async (req, res) => {
    const { orderId } = req.params;
    try {
        const order = await prisma.purchaseorder.findUnique({
            where: { id: orderId },
            select: { id: true, paymentStatus: true, status: true, statusDetail: true }
        });

        if (!order) return res.status(404).json({ error: 'Order not found' });
        res.json(order);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch order status' });
    }
};

module.exports = { createCheckoutSession, getOrderStatus };
