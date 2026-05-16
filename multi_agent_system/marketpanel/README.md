
MarketPanel (beacon + redirect)

- Create short links that collect basic device/browser info, then redirect to any decoy URL (DEX, PDF, article, etc.).
- Mobile-friendly landing. Works on phones and desktops.
- Admin panel to create campaigns and view hits.

Deploy on Render
1) Push this folder to a GitHub repo.
2) In Render, create a new Web Service from the repo.
3) Set env vars:
   - ADMIN_PASSWORD: your password
   - BASE_URL: the public URL Render assigns (e.g., https://your-app.onrender.com)
4) Render will build with requirements.txt and start via gunicorn.

Usage
- Log in at /login with password.
- Create a campaign with a decoy URL (e.g., https://uniswap.org or a public PDF URL).
- Optional: set a custom slug.
- Copy the generated link and share.
- Hits appear in the panel with IP, UA, and optional geo if granted.
