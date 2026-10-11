# Tests the judge using the real runner code and a FAKE in-memory MongoDB (mongomock).
# No network, no real database needed.
import os, sys
root = os.path.dirname(os.path.dirname(__file__))
sys.path += [os.path.join(root, "runner"), os.path.join(root, "judge")]

import mongomock
import runner, judge

# 1) Swap the real MongoDB for a fake one, then load the starting problems into it
judge.db = mongomock.MongoClient()["leetcode"]
judge.seed_problems(judge.db)

# 2) Instead of HTTP, call the runner directly
runner_client = runner.app.test_client()

def fake_call_runner(code):
    r = runner_client.post("/execute", json={"code": code})
    return r.status_code, r.get_json()

judge.call_runner = fake_call_runner
client = judge.app.test_client()

def submit(problem_id, code):
    return client.post("/api/submit", json={"problem_id": problem_id, "code": code}).get_json()


def test_two_sum_correct():
    code = """class Solution:
    def twoSum(self, nums, target):
        seen = {}
        for i, n in enumerate(nums):
            if target - n in seen:
                return [seen[target - n], i]
            seen[n] = i
"""
    assert submit("two-sum", code)["verdict"] == "Accepted"


def test_parentheses_correct():
    code = """class Solution:
    def isValid(self, s):
        stack, pair = [], {')': '(', ']': '[', '}': '{'}
        for c in s:
            if c in pair:
                if not stack or stack.pop() != pair[c]:
                    return False
            else:
                stack.append(c)
        return not stack
"""
    assert submit("valid-parentheses", code)["verdict"] == "Accepted"


def test_wrong_answer():
    code = "class Solution:\n    def twoSum(self, nums, target):\n        return [0, 0]\n"
    assert submit("two-sum", code)["verdict"] == "Wrong Answer"


def test_crash():
    assert submit("two-sum", "this is not python")["verdict"] == "Runtime Error"


def test_infinite_loop():
    code = "class Solution:\n    def isValid(self, s):\n        while True: pass\n"
    assert submit("valid-parentheses", code)["verdict"] == "Time Limit Exceeded"


def test_problems_come_from_mongodb_and_hide_tests():
    listing = client.get("/api/problems").get_json()
    assert {p["id"] for p in listing} == {"two-sum", "valid-parentheses"}
    one = client.get("/api/problems/two-sum").get_json()
    assert "tests" not in one and "starter" in one          # hidden tests never leave the server


def test_submissions_saved_in_mongodb():
    before = judge.db.submissions.count_documents({})
    submit("two-sum", "class Solution:\n    def twoSum(self, nums, target):\n        return [0, 0]\n")
    assert judge.db.submissions.count_documents({}) == before + 1
    history = client.get("/api/submissions").get_json()
    assert history[0]["problem_id"] == "two-sum" and "_id" not in history[0]


def test_seeding_never_overwrites_edits():
    judge.db.problems.update_one({"_id": "two-sum"}, {"$set": {"title": "Edited in MongoDB"}})
    judge.seed_problems(judge.db)                           # simulates a restart
    assert judge.db.problems.find_one({"_id": "two-sum"})["title"] == "Edited in MongoDB"
    assert judge.db.problems.count_documents({}) == 2       # no duplicates


def test_injection_is_rejected():
    r = client.post("/api/submit", json={"problem_id": {"$ne": None}, "code": "print(1)"})
    assert r.status_code == 400
