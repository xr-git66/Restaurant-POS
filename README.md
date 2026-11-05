# Shop POS (restaurant)

A billing / POS web app with a real database (SQLite).

## Run it
1. Install Node.js (LTS, version 22.13 or newer) from https://nodejs.org
2. Open this folder in VS Code (File > Open Folder)
3. Open the terminal in VS Code (Terminal > New Terminal) and run:

       node server.js

4. Open http://localhost:3000 in Chrome or Edge.

No `npm install` is needed. Stop the server with Ctrl+C.

## Where things are
- `server.js`        the server and the database code
- `public/index.html` the POS screen you see in the browser
- `shop.db`          your database (created automatically the first time you run it)

## Back up your data
Copy `shop.db` somewhere safe (USB drive or cloud folder) while the server is stopped.
Use "Export CSV" on the Sales tab for a spreadsheet copy of your sales.

## Notes
- The server only accepts connections from this computer. That is also what the
  cash drawer buttons need (browsers allow USB/serial access on localhost).
- There is no login yet. Do not put this on the public internet until one is added.
