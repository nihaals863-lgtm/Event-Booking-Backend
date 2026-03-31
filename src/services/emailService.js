const sgMail = require('@sendgrid/mail');
const qrcode = require('qrcode');
const puppeteer = require('puppeteer');

// Configure SendGrid
if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL;
const REPLY_TO_EMAIL = process.env.SENDGRID_REPLY_TO_EMAIL || process.env.ADMIN_EMAIL;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

// Puppeteer Singleton Browser Manager
let browserInstance = null;
async function getBrowser() {
    if (!browserInstance || !browserInstance.isConnected()) {
        try {
            if (browserInstance) {
                await browserInstance.close().catch(() => {});
            }
            browserInstance = await puppeteer.launch({
                headless: 'new',
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            });
            console.log('[BROWSER] Singleton browser instance launched.');
            
            browserInstance.on('disconnected', () => {
                console.log('[BROWSER] Browser disconnected.');
                browserInstance = null;
            });
        } catch (error) {
            console.error('[BROWSER_ERROR] Failed to launch browser:', error.message);
            throw error;
        }
    }
    return browserInstance;
}

/**
 * Helper to wrap a promise with a timeout
 */
function withTimeout(promise, ms, errorName) {
    const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`${errorName} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]);
}

/**
 * Generate QR Code as Base64 Data URL
 */
async function generateQRCode(payload, orderId = 'N/A') {
    try {
        const dataUrl = await withTimeout(qrcode.toDataURL(payload), 5000, 'QR_GENERATION');
        return dataUrl;
    } catch (error) {
        console.error(`[QR_ERROR] orderId=${orderId} error=${error.message}`);
        return null;
    }
}

/**
 * Generate a minimalist PDF ticket
 */
async function generateTicketPDF(eventData, attendeeData, orderData, qrBase64) {
    let page = null;
    try {
        const browser = await getBrowser();
        page = await browser.newPage();

        const htmlContent = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: 'Helvetica', sans-serif; margin: 40px; color: #333; }
                    .ticket { border: 2px solid #EEE; padding: 20px; max-width: 600px; margin: auto; border-radius: 8px; }
                    .header { text-align: center; border-bottom: 2px solid #F5F5F5; padding-bottom: 20px; }
                    .event-name { font-size: 24px; font-weight: bold; margin: 10px 0; color: #1A1A1A; }
                    .details { margin: 20px 0; font-size: 14px; line-height: 1.6; }
                    .label { color: #888; text-transform: uppercase; font-size: 10px; font-weight: bold; letter-spacing: 1px; }
                    .qr-section { text-align: center; margin-top: 30px; }
                    .qr-image { width: 140px; height: 140px; border: 1px solid #EEE; padding: 10px; border-radius: 4px; }
                    .footer { text-align: center; font-size: 10px; color: #AAA; margin-top: 40px; border-top: 1px solid #F5F5F5; padding-top: 15px; }
                </style>
            </head>
            <body>
                <div class="ticket">
                    <div class="header">
                        <div class="label">Event Ticket</div>
                        <div class="event-name">${eventData.title}</div>
                    </div>
                    <div class="details">
                        <div style="float: left; width: 50%;">
                            <p><span class="label">Attendee</span><br><strong>${attendeeData.name}</strong></p>
                            <p><span class="label">Order ID</span><br>${orderData.id}</p>
                        </div>
                        <div style="float: left; width: 50%;">
                            <p><span class="label">Amount Paid</span><br>${orderData.amount}</p>
                        </div>
                        <div style="clear: both;"></div>
                    </div>
                    <div class="qr-section">
                        <img class="qr-image" src="${qrBase64}" />
                        <div class="label" style="margin-top: 10px;">Scan at Entry</div>
                    </div>
                    <div class="footer">
                        Powered by EventHubix • This ticket is valid for one entry only.<br>
                        For refunds, contact us at ${REPLY_TO_EMAIL}
                    </div>
                </div>
            </body>
            </html>
        `;

        await withTimeout(page.setContent(htmlContent), 5000, 'PDF_CONTENT_SET');
        const pdfBuffer = await withTimeout(page.pdf({ format: 'A4', printBackground: true }), 5000, 'PDF_GENERATION');
        return pdfBuffer;
    } catch (error) {
        console.error(`[PDF_ERROR] orderId=${orderData.id} error=${error.message}`);
        return null;
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

/**
 * Base Layout Wrapper for consistency
 */
function getEmailLayout(content, preheader = '') {
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                @media only screen and (max-width: 620px) {
                    .container { width: 100% !important; padding: 10px !important; }
                    .content { padding: 20px !important; }
                }
            </style>
        </head>
        <body style="background-color: #F3F4F6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 40px 0; -webkit-font-smoothing: antialiased;">
            <div style="display: none; max-height: 0; overflow: hidden;">${preheader}</div>
            <table class="container" border="0" cellpadding="0" cellspacing="0" width="600" align="center" style="margin: 0 auto; background-color: #FFFFFF; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                <!-- Header -->
                <tr>
                    <td style="background-color: #4F46E5; padding: 30px; text-align: center;">
                        <h1 style="color: #FFFFFF; margin: 0; font-size: 28px; font-weight: 800; letter-spacing: -0.5px;">EventHubix</h1>
                    </td>
                </tr>
                <!-- Body -->
                <tr>
                    <td class="content" style="padding: 40px;">
                        ${content}
                    </td>
                </tr>
                <!-- Footer -->
                <tr>
                    <td style="padding: 30px; text-align: center; background-color: #F9FAFB; border-top: 1px solid #E5E7EB;">
                        <p style="margin: 0; color: #6B7280; font-size: 14px;">© 2026 <strong>EventHubix</strong></p>
                        <p style="margin: 8px 0 0; color: #9CA3AF; font-size: 12px; line-height: 1.6;">
                            Need help? Contact <a href="mailto:${REPLY_TO_EMAIL}" style="color: #4F46E5; text-decoration: none;">${REPLY_TO_EMAIL}</a><br>
                            For refunds, contact us at <span style="color: #4F46E5;">${REPLY_TO_EMAIL}</span><br>
                            <span style="font-size: 10px; opacity: 0.8; display: block; margin-top: 10px;">
                                By using EventHubix, you agree to our <a href="https://event-ticket-platform1.netlify.app/terms-and-conditions" style="color: #4F46E5; text-decoration: underline;">Terms & Conditions</a>. 
                                Your data is handled according to our <a href="https://event-ticket-platform1.netlify.app/privacy-policy" style="color: #4F46E5; text-decoration: underline;">Privacy Policy</a>.
                            </span>
                        </p>
                    </td>
                </tr>
            </table>
        </body>
        </html>
    `;
}

/**
 * Modern CTA Button helper
 */
function getCTAButton(text, url) {
    return `
        <div style="text-align: center; margin: 30px 0;">
            <a href="${url}" style="background-color: #4F46E5; color: #FFFFFF; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 700; display: inline-block; font-size: 16px; box-shadow: 0 4px 6px -1px rgba(79, 70, 229, 0.2);">
                ${text}
            </a>
        </div>
    `;
}

/**
 * Template: Ticket Confirmation (Buyer)
 */
function getTicketConfirmationTemplate({ attendeeName, eventTitle, eventDate, location, orderId, amount, ticketsCount, qrBase64 }) {
        const formattedDate = (eventDate instanceof Date) 
            ? eventDate.toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })
            : (eventDate || 'Coming Soon');

        const content = `
            <h2 style="margin: 0 0 15px; color: #111827; font-size: 24px; text-align: center;">Hi ${attendeeName} 👋</h2>
            <p style="margin: 0 0 25px; color: #4B5563; font-size: 16px; text-align: center; line-height: 1.5;">
                Your ticket is confirmed! We're excited to see you at <strong>${eventTitle}</strong>.
            </p>
            
            <div style="background-color: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 12px; padding: 25px; margin-bottom: 30px;">
                <table border="0" cellpadding="0" cellspacing="0" width="100%">
                    <tr>
                        <td style="padding-bottom: 15px; color: #6B7280; font-size: 12px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.05em;">Event Details</td>
                    </tr>
                    <tr>
                        <td style="font-size: 16px; color: #111827; line-height: 1.6;">
                            <strong style="font-size: 18px; color: #4F46E5;">${eventTitle}</strong><br>
                            📅 ${formattedDate}<br>
                            📍 ${location || 'Venue TBD'}
                        </td>
                    </tr>
                <tr><td style="padding: 15px 0; border-bottom: 1px solid #EEF2F6;"></td></tr>
                <tr>
                    <td style="padding-top: 15px;">
                        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="font-size: 14px; color: #4B5563;">
                            <tr>
                                <td style="padding: 4px 0;">Order ID</td>
                                <td align="right" style="color: #111827; font-family: monospace; font-weight: 700;">${orderId}</td>
                            </tr>
                            <tr>
                                <td style="padding: 4px 0;">Tickets</td>
                                <td align="right" style="color: #111827; font-weight: 700;">${ticketsCount} Admit(s)</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0 0; color: #111827; font-weight: 700;">Total Amount</td>
                                <td align="right" style="padding: 8px 0 0; color: #111827; font-weight: 800; font-size: 18px;">${amount}</td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </div>

        ${qrBase64 ? `
        <div style="text-align: center; padding: 20px; border: 2px dashed #E5E7EB; border-radius: 16px; margin: 30px 0;">
            <img src="cid:ticket_qr" width="160" height="160" style="display: block; margin: 0 auto;" alt="Ticket QR Code" />
            <p style="margin: 15px 0 0; color: #9CA3AF; font-size: 11px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.1em;">Please show this QR code at the venue</p>
        </div>
        ` : ''}

        ${getCTAButton('View My Tickets', 'https://event-ticket-platform1.netlify.app/tickets')}
    `;
    return getEmailLayout(content, `Your ticket for ${eventTitle} is ready!`);
}

/**
 * Template: Organizer Notification (Sale)
 */
function getOrganizerNotificationTemplate({ organizerName, eventTitle, quantity, amount, orderId, buyerName, buyerEmail }) {
    const content = `
        <h2 style="margin: 0 0 8px; color: #10B981; font-size: 24px; text-align: center;">🎉 Ticket Sold!</h2>
        <p style="margin: 0 0 25px; color: #4B5563; font-size: 16px; text-align: center;">
            You have a new attendee for your event: <strong>${eventTitle}</strong>
        </p>

        <div style="background-color: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 12px; padding: 25px;">
            <h3 style="margin: 0 0 15px; color: #111827; font-size: 14px; text-transform: uppercase;">Transaction Details</h3>
            <table border="0" cellpadding="0" cellspacing="0" width="100%" style="font-size: 15px; border-collapse: collapse;">
                <tr style="border-bottom: 1px solid #F3F4F6;">
                    <td style="padding: 12px 0; color: #6B7280;">Order ID</td>
                    <td align="right" style="padding: 12px 0; font-weight: 700;">${orderId}</td>
                </tr>
                <tr style="border-bottom: 1px solid #F3F4F6;">
                    <td style="padding: 12px 0; color: #6B7280;">Buyer</td>
                    <td align="right" style="padding: 12px 0; font-weight: 700;">${buyerName}</td>
                </tr>
                <tr style="border-bottom: 1px solid #F3F4F6;">
                    <td style="padding: 12px 0; color: #6B7280;">Buyer Email</td>
                    <td align="right" style="padding: 12px 0; font-weight: 700; color: #4F46E5;">${buyerEmail}</td>
                </tr>
                <tr style="border-bottom: 1px solid #F3F4F6;">
                    <td style="padding: 12px 0; color: #6B7280;">Quantity</td>
                    <td align="right" style="padding: 12px 0; font-weight: 700;">${quantity} Ticket(s)</td>
                </tr>
                <tr>
                    <td style="padding: 15px 0 0; font-weight: 800; font-size: 18px; color: #111827;">Total Revenue</td>
                    <td align="right" style="padding: 15px 0 0; font-weight: 800; font-size: 22px; color: #4F46E5;">${amount}</td>
                </tr>
            </table>
        </div>

        ${getCTAButton('View Dashboard', 'https://event-ticket-platform1.netlify.app/organizer/dashboard')}
    `;
    return getEmailLayout(content, `You just sold ${quantity} tickets for ${eventTitle}`);
}

/**
 * Template: Admin Notification (New Organizer)
 */
function getAdminNotificationTemplate({ organizerName, organizerEmail, timestamp }) {
    const content = `
        <h2 style="margin: 0 0 8px; color: #4F46E5; font-size: 22px;">🆕 New Organizer Registration</h2>
        <p style="margin: 0 0 25px; color: #4B5563; font-size: 15px;">
            A new user has registered as an organizer and is awaiting approval.
        </p>

        <div style="background-color: #FEF2F2; border: 1px solid #FEE2E2; border-radius: 8px; padding: 12px 16px; margin-bottom: 25px;">
            <p style="margin: 0; color: #B91C1C; font-size: 13px; font-weight: 600;">Status: Pending Admin Approval</p>
        </div>

        <div style="background-color: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 12px; padding: 25px; margin-bottom: 25px;">
            <table border="0" cellpadding="0" cellspacing="0" width="100%" style="font-size: 15px;">
                <tr>
                    <td style="padding: 8px 0; color: #6B7280;">Name</td>
                    <td align="right" style="padding: 8px 0; font-weight: 700; color: #111827;">${organizerName}</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #6B7280;">Email</td>
                    <td align="right" style="padding: 8px 0; font-weight: 700; color: #4F46E5;">${organizerEmail}</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #6B7280;">Timestamp</td>
                    <td align="right" style="padding: 8px 0; color: #111827;">${timestamp}</td>
                </tr>
            </table>
        </div>

        ${getCTAButton('Review Organizer', 'https://event-ticket-platform1.netlify.app/admin/approvals')}
    `;
    return getEmailLayout(content, `New organizer registration: ${organizerName}`);
}

/**
 * Template: Newsletter Welcome
 */
function getNewsletterWelcomeTemplate(email) {
    const content = `
        <h2 style="margin: 0 0 15px; color: #111827; font-size: 24px; text-align: center;">Welcome to the Loop! 🚀</h2>
        <p style="margin: 0 0 25px; color: #4B5563; font-size: 16px; text-align: center; line-height: 1.6;">
            Thanks for subscribing to the <strong>EventHubix</strong> newsletter. You're now officially in the inner circle!
        </p>
        
        <div style="background-color: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 12px; padding: 25px; margin-bottom: 30px;">
            <p style="margin: 0; color: #4B5563; font-size: 15px; line-height: 1.6;">
                Get ready for:
                <ul style="margin: 15px 0 0; padding-left: 20px; color: #4B5563;">
                    <li style="margin-bottom: 8px;">Exclusive event marketing tips</li>
                    <li style="margin-bottom: 8px;">Early access to new features</li>
                    <li style="margin-bottom: 8px;">Industry news and trends</li>
                </ul>
            </p>
        </div>

        <p style="margin: 0 0 20px; color: #6B7280; font-size: 14px; text-align: center;">
            You are receiving this because you subscribed at <span style="color: #4F46E5;">eventhubix.com</span>
        </p>

        ${getCTAButton('Explore Events', 'https://event-ticket-platform1.netlify.app/events')}
    `;
    return getEmailLayout(content, "You're now subscribed to EventHubix!");
}

/**
 * Retry wrapper for SendGrid API calls
 */
async function sendWithRetry(sendFn, retries = 3, logType = 'unknown') {
    try {
        return await sendFn();
    } catch (err) {
        if (retries === 0) throw err;
        console.warn(`[EMAIL_RETRY] type=${logType} attempts_left=${retries} error=${err.message}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return sendWithRetry(sendFn, retries - 1, logType);
    }
}

/**
 * Generic internal function to send emails safely.
 */
async function sendEmailRaw(msg, logType = 'unknown', orderId = 'N/A') {
    if (!process.env.SENDGRID_API_KEY || !FROM_EMAIL) {
        console.warn(`[EMAIL_SKIPPED] Missing SendGrid configuration. type=${logType} to=${msg.to}`);
        return;
    }

    try {
        msg.from = FROM_EMAIL;
        msg.replyTo = REPLY_TO_EMAIL;

        console.log(`[EMAIL_DEBUG] type=${logType} to=${msg.to} orderId=${orderId}`);
        const response = await sendWithRetry(() => sgMail.send(msg), 3, logType);
        console.log(`[EMAIL_SUCCESS] status=${response[0].statusCode} to=${msg.to} type=${logType}`);
    } catch (error) {
        console.error(`[EMAIL_ERROR] to=${msg.to} type=${logType} message=${error.message}`);
        if (error.response) {
            console.error(JSON.stringify(error.response.body));
        }
    }
}

/**
 * Send ticket confirmation to the attendee.
 */
async function sendTicketConfirmation(attendeeData, orderData, tickets) {
    const primaryTicket = tickets[0];
    let qrBase64 = null;
    let pdfBuffer = null;

    if (primaryTicket) {
        qrBase64 = await generateQRCode(primaryTicket.qrPayload, orderData.id);
        if (qrBase64) {
            pdfBuffer = await generateTicketPDF({ title: orderData.eventTitle }, attendeeData, orderData, qrBase64);
        }
    }

    const htmlTemplate = getTicketConfirmationTemplate({
        attendeeName: attendeeData.name,
        eventTitle: orderData.eventTitle,
        eventDate: orderData.eventDate, // Added if available
        location: orderData.location,   // Added if available
        orderId: orderData.id,
        amount: orderData.amount,
        ticketsCount: tickets.length,
        qrBase64
    });

    let attachments = [];
    
    // CID Attachment for QR Code (Inline)
    if (qrBase64) {
        const base64Data = qrBase64.split(',')[1]; // Extract raw base64
        attachments.push({
            content: base64Data,
            filename: 'qr.png',
            type: 'image/png',
            disposition: 'inline',
            content_id: 'ticket_qr'
        });
    }

    if (pdfBuffer) {
        try {
            const base64Content = Buffer.from(pdfBuffer).toString('base64');
            attachments.push({
                content: base64Content,
                filename: `ticket-${orderData.id}.pdf`,
                type: 'application/pdf',
                disposition: 'attachment'
            });
            console.log(`[EMAIL_DEBUG] type=attachment_ready orderId=${orderData.id} size=${base64Content.length} chars`);
        } catch (encodingError) {
            console.error(`[EMAIL_ERROR] type=encoding_failed orderId=${orderData.id} error=${encodingError.message}`);
        }
    }

    const msg = {
        to: attendeeData.email,
        subject: `Your Tickets for ${orderData.eventTitle} - ${orderData.id}`,
        text: `Hi ${attendeeData.name}, your purchase for ${orderData.eventTitle} was successful! Order ID: ${orderData.id}.`,
        html: htmlTemplate,
        attachments: attachments
    };
 
    await sendEmailRaw(msg, 'ticket_confirmation', orderData.id);
}

/**
 * Notify organizer about a sale.
 */
async function sendOrganizerSaleNotification(organizerEmail, eventTitle, quantity, amount, orderId, buyerName, buyerEmail) {
    if (!organizerEmail) {
        console.warn(`[EMAIL_SKIPPED] type=organizer_ticket_sold reason=missing_email`);
        return;
    }

    const htmlTemplate = getOrganizerNotificationTemplate({
        eventTitle,
        quantity,
        amount,
        orderId,
        buyerName,
        buyerEmail
    });

    const msg = {
        to: organizerEmail,
        subject: `🎉 Ticket Sold! - ${eventTitle}`,
        text: `Great news! You just sold ${quantity} ticket(s) for your event: ${eventTitle}. Amount: ${amount}. Buyer: ${buyerName} (${buyerEmail})`,
        html: htmlTemplate,
    };
    await sendEmailRaw(msg, 'organizer_ticket_sold', orderId);
}

/**
 * Notify admin about a new organizer registration.
 */
async function sendAdminNewOrganizerAlert(organizerData) {
    if (!ADMIN_EMAIL) {
        console.warn(`[EMAIL_SKIPPED] type=admin_new_organizer reason=missing_admin_email`);
        return;
    }

    const timestamp = new Date().toLocaleString("en-AU", {
        dateStyle: "medium",
        timeStyle: "short"
    });

    const htmlTemplate = getAdminNotificationTemplate({
        organizerName: organizerData.name,
        organizerEmail: organizerData.email,
        timestamp
    });

    const msg = {
        to: ADMIN_EMAIL,
        subject: `🆕 New Organizer: ${organizerData.name}`,
        text: `A new organizer has registered: ${organizerData.name} (${organizerData.email}). Time: ${timestamp}`,
        html: htmlTemplate,
    };
    await sendEmailRaw(msg, 'admin_new_organizer');
}

/**
 * Send newsletter welcome email.
 */
async function sendNewsletterWelcome(email) {
    const htmlTemplate = getNewsletterWelcomeTemplate(email);
    const msg = {
        to: email,
        subject: `Welcome to EventHubix! 🚀`,
        text: `Thanks for subscribing to the EventHubix newsletter! We'll keep you updated with the latest event tips and news.`,
        html: htmlTemplate,
    };
    await sendEmailRaw(msg, 'newsletter_welcome');
}

/**
 * Orchestrator for purchase-related emails (fire-and-forget).
 */
function processPurchaseEmails({ attendeeEmail, attendeeName, orderId, totalAmount, eventTitle, eventDate, location, organizerEmail, tickets }) {
    // FIRE-AND-FORGET to avoid blocking the main thread
    setImmediate(async () => {
        try {
            await Promise.allSettled([
                sendTicketConfirmation(
                    { name: attendeeName, email: attendeeEmail }, 
                    { id: orderId, amount: totalAmount, eventTitle, eventDate, location }, 
                    tickets
                ),
                sendOrganizerSaleNotification(organizerEmail, eventTitle, tickets.length, totalAmount, orderId, attendeeName, attendeeEmail)
            ]);
        } catch (err) {
            console.error('[EMAIL_ORCHESTRATOR_ERROR] Critical failure in email batch:', err.message);
        }
    });
}

module.exports = {
    sendTicketConfirmation,
    sendOrganizerSaleNotification,
    sendAdminNewOrganizerAlert,
    sendNewsletterWelcome,
    processPurchaseEmails
};
