"""Eenmalige Garmin-login voor Health Hub.
Gebruik (Python 3.12+):
    pip install garminconnect
    python tools/garmin_login.py
    npx supabase secrets set --env-file garmin.env
    del garmin.env        (Windows)  /  rm garmin.env  (Mac/Linux)
Je wachtwoord gaat alleen naar Garmin; het bestand bevat enkel de login-sleutel.
"""
import base64, getpass, json, tempfile, pathlib
from garminconnect import Garmin

email = input("Garmin e-mail: ").strip()
pw = getpass.getpass("Garmin wachtwoord: ")
g = Garmin(email, pw, prompt_mfa=lambda: input("Code uit e-mail/app (MFA): ").strip())
with tempfile.TemporaryDirectory() as d:
    g.login(d)
    tok = json.loads((pathlib.Path(d) / "garmin_tokens.json").read_text())
if not tok.get("di_refresh_token"):
    raise SystemExit("Geen refresh-token ontvangen; probeer opnieuw.")
b64 = base64.b64encode(json.dumps(tok).encode()).decode()
pathlib.Path("garmin.env").write_text(f"GARMIN_TOKENS={b64}\n")
print("OK: garmin.env aangemaakt. Nu: npx supabase secrets set --env-file garmin.env  en daarna garmin.env verwijderen.")
