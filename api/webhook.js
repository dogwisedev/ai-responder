import { Client } from '@hubspot/api-client';

const hubspot = new Client({ accessToken: process.env.HUBSPOT_ACCESS_TOKEN });

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { data } = req.body; 
    // OpenPhone payload contains 'from' (customer) and 'to' (your rep)
    const customerPhone = data.object.from;

    try {
        // Find contact by phone
        const searchResponse = await hubspot.crm.contacts.searchApi.doSearch({
            filterGroups: [{
                filters: [{ propertyName: 'phone', operator: 'EQ', value: customerPhone }]
            }]
        });

        if (searchResponse.results.length > 0) {
            const contactId = searchResponse.results[0].id;
            // Update the deal associated with this contact
            // Note: In a real setup, you'd find the latest 'Open' deal
            await hubspot.crm.contacts.basicApi.update(contactId, {
                properties: { sms_reply_status: 'Reply Needed' }
            });
        }
        
        res.status(200).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}
