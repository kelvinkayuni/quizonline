# ONLINE QUIZ

A browser-based quiz dashboard with separate teacher and student experiences.

## Run

Open `index.html` directly in a browser. An internet connection is needed for the Google Fonts and SheetJS CDN assets used by the interface and Excel tools.

## Demo access

- Teacher: `kelvin kayuni` / `3001`
- Student: `student` / `3001`

## Included

- Teacher dashboard with overview, question bank, quiz configuration, student Excel import, live monitoring, and results export.
- Reusable multiple-choice questions with 2-8 choices and per-question marks.
- Student quiz flow with one question at a time, submit-gated feedback, timer, automatic submission, and no retakes after completion.
- Shared quiz data persists through `localStorage`, while each browser window keeps its own login/session through `sessionStorage`.
- `.xlsx` student import and results download through SheetJS.

This is a frontend prototype. A second window in the same browser can now hold a different student login without logging out the first window. Different browsers cannot share `localStorage` or `sessionStorage`; cross-browser live accounts, quiz data, and synchronization require a server-side backend and shared database.
