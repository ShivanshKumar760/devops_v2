import json,os,time
from urllib.parse import quote_plus

import requests
from flask import Flask , request , jsonify , send_from_directory
from pymongo import MongoClient
from pymongo.errors import PyMongoError


app = Flask(__name__)

REGION=os.environ.get("REGION","local")

@app.after_request
def add_region_header(resp):
    resp.headers["X-Served-By"] = REGION
    return resp

RUNNER_URL = "http://" + os.environ.get("RUNNER_HOSTPORT", "localhost:5001")

def build_mongo_uri():
    if os.environ.get("MONGO_URI"):
        return os.environ("MONGO_URI")
    host = os.environ.get("MONGO_HOST")
    if not host:
        return None
    user = quote_plus(os.environ["MONGO_USER"])
    password = quote_plus(os.environ["MANGO_PASSWORD"])
    return f"mongodb://{user}:{password}@{host}:27017/?authSource=admin"

MONGO_URI = build_mongo_uri()

client = MongoClient(MONGO_URI or "mongodb://localhost:27017",serverSelectionTimeoutMS=3000)
db = client["leetcode"]


SEED_PROBLEMS = [
    {
        "_id": "two-sum",        # in MongoDB, _id is the primary key
        "title": "Two Sum (Easy)",
        "description": "Return the indices of the two numbers in `nums` that add up to `target`.\n"
                       "Example: nums=[2,7,11,15], target=9 -> [0,1]",
        "function": "twoSum",
        "starter": "class Solution:\n    def twoSum(self, nums, target):\n        pass\n",
        "tests": [
            {"args": [[2, 7, 11, 15], 9], "expected": [0, 1]},
            {"args": [[3, 2, 4], 6], "expected": [1, 2]},
            {"args": [[3, 3], 6], "expected": [0, 1]},
            {"args": [[-1, -2, -3, -4, -5], -8], "expected": [2, 4]},
            {"args": [[0, 4, 3, 0], 0], "expected": [0, 3]},
        ],
    },
    {
        "_id": "valid-parentheses",
        "title": "Valid Parentheses (Easy)",
        "description": "Return True if the brackets in string `s` are closed in the correct order.\n"
                       'Example: "()[]{}" -> True,  "(]" -> False',
        "function": "isValid",
        "starter": "class Solution:\n    def isValid(self, s):\n        pass\n",
        "tests": [
            {"args": ["()"], "expected": True},
            {"args": ["()[]{}"], "expected": True},
            {"args": ["(]"], "expected": False},
            {"args": ["([)]"], "expected": False},
            {"args": ["{[]}"], "expected": True},
            {"args": ["("], "expected": False},
        ],
    },
]


def seed_problems(database):
    for p in SEED_PROBLEMS:
        fields = {k: v for k, v in p.items() if k != "_id"}
        database.problems.update_one({"_id":p["_id"]},{"$setOnInsert":fields},upsert=True)

def wait_and_seed():
    for _ in range(20):
        try:
            seed_problems(db)
            print("MongoDB ready , problems seeded",flush=True)
            return
        except PyMongoError as e:
            print("waiting for MongoDB...",e,flush=True)
            time.sleep(2)
    print("WARNING: could not reach MongoDB",flush=True)

if MONGO_URI:
    wait_and_seed()

@app.errorhandler(PyMongoError)
def database_down(err):
    return jsonify(error="database unavailable"),503

def call_runner(code):
    r = requests.post(RUNNER_URL + "/execute", json={"code": code}, timeout=15)
    return r.status_code , r.json()

def same(got,expected):
    if isinstance(got,list) and isinstance(expected,list):
        return sorted(got) == sorted(expected)
    return got == expected

def judge(problem,user_code):
    tests = problem["test"]
    for number , test in enumerate(tests,start=1):
        args , expected = test["args"],test["expected"]
        script = (user_code + "\n\nimport json\n"
                  f"print('RESULT:' + json.dumps(Solution().{problem['function']}(*{args!r})))\n")
        try:
            status , out = call_runner(script)
        except requests.RequestException:
            return {"verdict": "Judge Error", "passed": number - 1, "total": len(tests)}

        if status == 408:
            return {"verdict":"Time Limit Exceeded","passed":number-1,"total":len(tests)}
        if out["exit_code"] !=0 :
            return {"verdict": "Runtime Error", "passed": number - 1, "total": len(tests),"error": out["stderr"][-500:]}

        lines =[l for l in out["stdout"].splitlines() if l.startswith("RESULT:")]
        got = json.loads(lines[-1][len("RESULT:"):]) if lines else None
        # got = json.loads(lines[-1][len("RESULT:"):]) if lines else None
        if not same(got,expected):
            return {"verdict": "Wrong Answer", "passed": number - 1, "total": len(tests)}
    return {"verdict": "Accepted", "passed": len(tests), "total": len(tests)}


@app.route("/")
def home():
    return send_from_directory(os.path.dirname(os.path.abspath(__file__)), "index.html")


@app.route("/health")
def health():
    return jsonify(status="ok")                       # process is alive


@app.route("/ready")
def ready():
    client.admin.command("ping")                      # raises if MongoDB is down -> 503
    return jsonify(status="ready")


@app.route("/api/problems")
def list_problems():
    cursor = db.problems.find({}, {"title": 1}).sort("_id", 1)
    return jsonify([{"id": p["_id"], "title": p["title"]} for p in cursor])


@app.route("/api/problems/<pid>")
def get_problem(pid):
    # The projection hides the "tests" field, so hidden test cases never leave the server.
    p = db.problems.find_one({"_id": pid}, {"description": 1, "starter": 1})
    if not p:
        return jsonify(error="not found"), 404
    return jsonify(description=p["description"], starter=p["starter"])


@app.route("/api/submit", methods=["POST"])
def submit():
    data = request.get_json(silent=True) or {}
    pid, code = data.get("problem_id"), data.get("code")
    # isinstance(str) matters: a dict like {"$ne": null} here would be a MongoDB injection.
    if not isinstance(pid, str) or not isinstance(code, str) or not code.strip():
        return jsonify(error="need problem_id and code"), 400
    problem = db.problems.find_one({"_id": pid})
    if not problem:
        return jsonify(error="unknown problem"), 400

    result = judge(problem, code)
    db.submissions.insert_one({"problem_id": pid, "at": time.time(), **result})
    return jsonify(result)


@app.route("/api/submissions")
def submissions():
    cursor = db.submissions.find({}, {"_id": 0, "at": 0}).sort("at", -1).limit(10)
    return jsonify(list(cursor))


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", 5000)))
