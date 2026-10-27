# 金記麵家 POS

Offline point-of-sale for Kim Kee Noodle, built for one iPad. Plain HTML/CSS/JS, no build step, no server needed after the first load.

## Features

- Menu by category, or type a code (e.g. `04S`, `k01`, `ad06`) and press Go to add it
- Required options per item (noodle type, hot/cold, Teh/C/O, set drink, kid set milk…), quick kitchen notes
- Dine-in / takeaway per item (takeaway +RM0.50, or takeaway with no charge); the top toggle switches the whole order. 10% service charge on dine-in items only, 6% SST on everything
- Payments: Cash (with change and 5-sen rounding), QR, Visa, Master, Debit, Bank In
- Hold an order (pay later), reopen it from Orders
- Orders list per day, reprint, void
- Daily report by payment method, dine-in/takeaway and items sold; print or export CSV
- Settings: receipt header, rates, sold-out per item, backup/restore (prices are the same for every outlet, set in `menu.js`)
- Cloud sync: each iPad is linked to an outlet with a device key and uploads orders to Supabase when online
- Owner dashboard (`dashboard.html`): sign in to see every outlet's sales, payments, items and orders

Orders are stored in the iPad browser's IndexedDB. **Back up weekly** from Settings → Backup.

## Files

| File | What |
|---|---|
| `menu.js` | Menu items, prices and option groups |
| `app.js` | App logic |
| `styles.css` | Layout and receipt print styles |
| `sw.js` | Offline cache (bump `CACHE` when files change) |

## Run locally

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765.

## Install on the iPad

The app has to be opened once from an `https://` address (e.g. GitHub Pages or Netlify). Then in Safari tap Share → Add to Home Screen. After that it opens from the home screen and works without internet.
