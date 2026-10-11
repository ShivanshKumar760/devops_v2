# import os , resource , subprocess , sys , tempfile
# from flask import Flask , request , jsonify

# app = Flask(__name__)

# def set_limits():
#     resource.setrlimit(resource.RLIMIT_CPU,(5,5))
#     resource.setrlimit(resource.RLIMIT_AS,(128*2**20,)*2)
#     resource.setrlimit(resource.RLIMIT_NPROC,(64,64))
#     resource.setrlimit(resource.RLIMIT_FSIZE,(2**20,2**20))


# @app.route("/"):
# def health():
#     return jsonify(status="ok")

# @app.route("/execute",methods=["POST"])
# def execute():
#     code = (request.get_json(silent=True) or {}).get("code")

#     if not isinstance(code,str) or not code:
#         return jsonify(error="send JSON like {'code':'...'}"),400
#     with tempfile.TemporaryDirectory() as folder:
#         path = os.path.join(folder,"script.py")
#         with open(path,"w") as f:
#             f.write(code)
#         try:
#             result = subprocess.run(
#                 [sys.executable,"-I",path],
#                 capture_output=True,
#                 text=True,
#                 timeout=5,
#                 preexec_fn=set_limits,
#                 cwd=folder,
#                 env={}
#             )
#         except subprocess.TimeoutExpired:
#             return jsonify(error="timeout"),408
#     return jsonify(stdout=result.stdout,stderr=result.stderr,exit_code=result.returncode)


# if __name__ == "__main__":
#     app.run(port=int(os.environ.get("PORT",5001)))



# ============================================================
# RUNNER SERVICE  (the "worker")
# Job: take Python code, run it safely-ish, return what it printed.
# It knows NOTHING about problems or test cases.
# ============================================================
import os, resource, subprocess, sys, tempfile
from flask import Flask, request, jsonify

app = Flask(__name__)


def set_limits():
    """Runs inside the child process just before the user's code starts."""
    resource.setrlimit(resource.RLIMIT_CPU, (5, 5))                    # max 5 sec of CPU
    resource.setrlimit(resource.RLIMIT_AS, (128 * 2**20,) * 2)         # max 128 MB memory
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))                # max 64 processes (fork bombs)
    resource.setrlimit(resource.RLIMIT_FSIZE, (2**20, 2**20))          # max 1 MB file writes


@app.route("/")
def health():
    return jsonify(status="ok")


@app.route("/execute", methods=["POST"])
def execute():
    code = (request.get_json(silent=True) or {}).get("code")
    if not isinstance(code, str) or not code:
        return jsonify(error="send JSON like {'code': '...'}"), 400

    with tempfile.TemporaryDirectory() as folder:          # folder is deleted afterwards
        path = os.path.join(folder, "script.py")
        with open(path, "w") as f:
            f.write(code)
        try:
            result = subprocess.run(
                [sys.executable, "-I", path],              # run the code as a separate process
                capture_output=True, text=True,
                timeout=5,                                  # kill after 5 seconds
                preexec_fn=set_limits,
                cwd=folder, env={},                         # empty env: no secrets leak in
            )
        except subprocess.TimeoutExpired:
            return jsonify(error="timeout"), 408

    return jsonify(stdout=result.stdout, stderr=result.stderr, exit_code=result.returncode)


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", 5001)))
