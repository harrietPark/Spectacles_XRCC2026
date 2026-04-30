# PinPoint

**Pin it. Say it. Sell it.**

PinPoint is a multi-platform spatial briefing system for showroom retail, built on Snap Spectacles, Snap Cloud, and a companion web portal. It captures what customers see and say, anchors those reactions to the exact products that triggered them, and delivers a structured, retrievable preference profile that turns cold introductions into informed consultations. In other words, the showroom stops being a place customers forget and starts being one that remembers them.
---

## 1. Problem

We saw a gap in showrooms: customers form rich spatial preferences while browsing, but most of that context is lost the moment it becomes a conversation. Intent is spatial; communication is verbal. Only a fraction of what they actually feel survives the translation. Worse, if a salesperson engages mid-browse, the customer has to start over from scratch, and the salesperson has to hold every detail in their head. What survives that translation isn't enough. Salespeople still need to dig through catalogs to find the right fit, and when staff turn over or customers return weeks later, the original context is gone with them. We built PinPoint to close that gap.

## 2. Solution

A self-service spatial briefing system for showroom customers. The customer wears Spectacles during their visit and naturally captures what they see and feel. AI processes these captures into a structured customer profile. The salesperson receives this profile before approaching, turning a cold discovery conversation into an informed consultation.

---

## 3. Features

### 1. Pin & Speak & Crop (Spectacles)

Customers look at a product through Spectacles, spawn a spatial note by touching or pointing at it, and speak their reaction: "I love this handle but the color is too cold." The system bundles a quiet image capture, voice recording, real-time transcript, and world-locked anchor into one retrievable brief pinned to the exact product. Customers can also crop visual references and attach voice notes the same way.

### 2. AI Preference Extraction & Catalog Matching (Snap Cloud)

Each brief is processed in realtime by Snap Cloud edge functions. Voice notes are transcribed, the target product is detected via Gemini-based object detection, and intent is extracted: style, color, material, function, budget. Results are matched against the company's product catalog (temporarily using IKEA's API) to surface alternatives. The aggregated profile builds as the customer browses. 

### 3. Companion Web Portal (Salesperson Dashboard)

A live web dashboard renders each pin as a card with image thumbnail, transcript, AI tags, summary, and pre-matched product recommendations. 

### 4. Live AR Recommendations (Two-Way Channel)

Salespeople can push product suggestions from the dashboard directly into the customer's Spectacles view in real time. The dashboard becomes a two-way channel, not a passive feed.

### 5. Cross-Session Memory

Profiles persist across visits and staff turnover via Snap Cloud. Returning customers' full spatial history loads instantly, and salespeople wearing Spectacles can walk the floor to see notes pinned exactly where the customer left them.

### 6. Session Recap & Catalog Intelligence

Every visit ends with a full recap: stats, saved images, AI summary, and one-tap email to the customer. For the business, every session feeds catalog intelligence and intent data for smarter product decisions.

---

## 4. Architecture

PinPoint is a **three-surface system** with one backend connecting two frontends:

```
┌────────────────────┐       ┌──────────────────┐       ┌────────────────────┐
│  Snap Spectacles   │◄─────►│   Snap Cloud     │◄─────►│   Web Portal       │
│  (Customer AR app) │       │   (Backend)      │       │   (Salesperson)    │
└────────────────────┘       └──────────────────┘       └────────────────────┘
   pin creation                 8 data tables              live dashboard
   voice capture                5 edge functions           realtime sync
   spatial anchors              product detection AI       recommendations
   AR recommendations           catalog matching           session recap
   crop                         realtime sync              customer profile & product insights
```

### Surface 1: Snap Spectacles AR App

Built in Lens Studio. Handles image capture via the Camera Module, voice recording and transcription via the Remote Service Gateway, and pin creation as world-anchored placements via the Spatial Anchors API. The Spectacles Interaction Kit provides hand interactors and the cursor for targeting products.

### Surface 2: Snap Cloud Backend

The intelligence layer. Designed so AR processing stays on Spectacles and everything else runs in the cloud, keeping the glasses responsive and avoiding thermal throttling.

**8 data tables**, for example:
- Sessions
- Pins
- Products
- Visit Summaries
- Recommendations

**5 edge functions** handle:
1. Product object detection (Gemini models, predefined product classes)
2. AI summary generation
3. Intent and preference extraction
4. Catalog matching
5. Spawning recommended products in AR

### Surface 3: Companion Web Portal: https://sylvanerd.github.io/PinPoint_Web/ 

Built in HTML, connected to Snap Cloud Realtime. Renders each spatial note as a card with image thumbnail, transcript, AI summary, intent tags, and recommended products as they arrive. Surfaces a customer profile view aggregating preferences across sessions, and a product insight view showing how items are reacted to across the catalog. Salesperson can trigger pushes back to the Spectacles view from this surface.
