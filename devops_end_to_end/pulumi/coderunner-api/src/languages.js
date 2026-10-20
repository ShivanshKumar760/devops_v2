export const LANGUAGES={
    javascript:{
        image:'node:22-alpine',
        file:'main.js',
        cmd:'node /code/main.js < /code/input.txt',
    },
    python:{
        image:'python:3.13-alpine',
        file:'main.py',
        cmd:'python3 -u /code/main.py < /code/input.txt',
    },
};