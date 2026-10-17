import os
import sys
import shutil
import tempfile
import subprocess
import time 

from dotenv import load_dotenv
load_dotenv()

import psycopg
from flask import Flask , request , jsonify
from flask_jwt_extended import JWTManager , create_access_token , jwt_required , get_jwt_identity
from werkzeug.security import generate_password_hash, check_password_hash


app = Flask(__name__)


app.config["JWT_SECRET_KEY"] = os.environ["JWT_SECRET_KEY"]
jwt = JWTManager(app)

DATABASE_URL = os.environ["DATABASE_URL"]
REGION = os.getenv("REGION","local")


@app.after_request
def add_region_header(response):
    response.headers["X-Served-By"] = REGION
    return response

@app.get("/")
def health():
    return jsonify(status="Ok",region=REGION)


@app.get("/health/db")
def health_db():
    start = time.perf_counter()

    conn = psycopg.connect(DATABASE_URL)
    cur = conn.cursor()
    cur.execute("SELECT 1")

    ms = round((time.perf_counter()-start)*1000,1)
    return jsonify(status="Ok",region=REGION,db_ms=ms)

@app.post("/auth/signup")
def signup():
    data = request.get_json(silent=True) or {}
    name = data.get("name")
    email = data.get("email")
    password = data.get("password")

    if not name or not email or not password:
        return jsonify(error="name,email and password are required")

    password_hash = generate_password_hash(password)

    conn = psycopg.connect(DATABASE_URL)
    cur = conn.cursor()

    try:
        cur.execute(
            "INSERT INTO users (name,email,password_hash)"
            "VALUES (%s,%s,%s) RETURNING id,name,email",
            (name,email.lower(),password_hash),
        )

        row = cur.fetchone()
        conn.commit()
    except psycopg.errors.UniqueViolation:
        conn.close()
        return jsonify(error="Email already registered"),409

    conn.close()

    return jsonify(message="User created",user={"id":row[0],"name":row[1],"email":row[2]}),201


@app.post("/auth/login")
def login():
    data = request.get_json(silent=True) or {}
    email = data.get("email") or ""
    password = data.get("password") or ""

    conn = psycopg.connect(DATABASE_URL)
    cur = conn.cursor()
    cur.execute(
        "SELECT id,password_hash FROM users WHERE email = %s",
        (email.lower(),),
    )

    row = cur.fetchone()
    conn.close()

    if row is None or not check_password_hash(row[1],password):
        return jsonify(error="Invalid email or password"),401

    token = create_access_token(identity=str[row[0]])
    return jsonify(access_token=token)


# ---------- Protected routes ----------
@app.get("/auth/me")
@jwt_required()                       # rejects missing / tampered / expired tokens
def me():
    user_id = int(get_jwt_identity())  # the "sub" claim from the verified token

    conn = psycopg.connect(DATABASE_URL)
    cur = conn.cursor()
    cur.execute(
        "SELECT id, name, email FROM users WHERE id = %s",
        (user_id,),
    )
    row = cur.fetchone()
    conn.close()

    if row is None:
        return jsonify(error="User not found"), 404
    return jsonify(id=row[0], name=row[1], email=row[2])


@app.post("/execute")
@jwt_required()
def execute():
    data = request.get_json(silent=True) or {}
    code = data.get("code")
    if not code:
        return jsonify(error="Please provide code to run"), 400

    tmp_dir = tempfile.mkdtemp()
    try:
        script_path = os.path.join(tmp_dir, "script.py")
        f = open(script_path, "w")
        f.write(code)
        f.close()

        result = subprocess.run(
            [sys.executable, "script.py"],
            cwd=tmp_dir,
            capture_output=True,
            text=True,
            timeout=5,                          # stop infinite loops
            env={"PATH": "/usr/bin:/bin"},      # hide our DB password and JWT secret
        )
        return jsonify(message="Success", stdout=result.stdout, stderr=result.stderr)
    except subprocess.TimeoutExpired:
        return jsonify(error="Code took longer than 5 seconds"), 408
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")))
