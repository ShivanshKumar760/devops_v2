import os
import subprocess
import tempfile
import shutil
from datetime import timedelta
import dataset 
from dotenv import load_dotenv 
from flask import Flask , jsonify , request
from flask_jwt_extended import (
    JWTManager,
    create_access_token,
    create_refresh_token,
    get_jwt_identity,
    jwt_required
)

from sqlalchemy.exc import IntegrityError
from werkzeug.security import check_password_hash,generate_password_hash

load_dotenv()

app = Flask(__name__)
app.config["JWT_SECRET_KEY"]=os.environ["JWT_SECRET_KEY"]
app.config["JWT_ACCESS_TOKEN_EXPIRES"]=timedelta(minutes=30)
app.config["JWT_REFRESH_TOKEN_EXPIRES"]=timedelta(days=7)

jwt = JWTManager(app)

DATABASE_URL = os.environ["DATABASE_URL"]

db = dataset.connect(DATABASE_URL,engine_kwargs={"pool_pre_ping":True})

users = db["Users"]

@app.route("/",methods=["GET"])
def health():
    return jsonify({"status":"Ok"})

@app.route("/signup",methods=["POST"])
def signup():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    password = data.get("password") or ""

    if not name or not password:
        return jsonify(error="name and password are required"),400
    if users.find_one(name=name):
        return jsonify(error="user already exists"),409
    try:
        user_id = users.insert({
            "name":name,
            "password":generate_password_hash(password)
        })
    except IntegrityError:
        return jsonify(error="user already exists"),409
    return jsonify(message="signup success",id=user_id),201

@app.route("/signin",methods=["POST"])
def signin():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    password = data.get("password") or ""

    user = users.find_one(name=name)
    if not user or not check_password_hash(users["password"],password):
        return jsonify(error="invalid credentials"),401
    identity = str(users["id"])
    return jsonify(
        access_token=create_access_token(identity=identity),
        refresh_token=create_refresh_token(identity=identity),
    )

@app.route("/refresh",methods=["POST"])
@jwt_required(refresh=True)
def refresh():
    return jsonify(access_token=create_access_token(identity=get_jwt_identity()))

@app.route("/me", methods=["GET"])
@jwt_required()
def me():
    user = users.find_one(id=int(get_jwt_identity()))
    if not user:
        return jsonify(error="user not found"), 404
    return jsonify(id=user["id"], name=user["name"])  # never return the hash

@app.route("/execute",methods=["POST"])
@jwt_required()
def execute():
    data = request.get_json(silent=True) or {}
    code = data.get("code")
    if not code:
        return jsonify(error="Please provide code to run"),400
    if len(code)>20_000:
        return jsonify(error="code too large"),413
    tmp_dir = tempfile.mkdtemp()
    try:
        with open(os.path.join(tmp_dir,"script.py"),"w") as f:
            f.write(code)
        result = subprocess.run(
            ["python3","-I","script.py"],
            cwd=tmp_dir,
            capture_output=True,
            text=True,
            timeout=5,
            env={"PATH":"/usr/bin:/bin"},
        )
        return jsonify(
            message="Success",
            stdout=result.stdout[:10_000],
            stderr=result.stderr[:10_000],
            returncode=result.returncode,
        )
    except subprocess.TimeoutExpired:
        return jsonify(error="execution timed out (5s)"),408
    finally:
        shutil.rmtree(tmp_dir,ignore_errors=True)

if __name__ == "__main__":
    from waitress import serve
    serve(app,host="127.0.0.1",port=8000,threads=8)

