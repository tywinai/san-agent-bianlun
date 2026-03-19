set -e
set -u

MAD_PATH=$(cd "$(dirname "$0")" && pwd)
API_KEY="${OPENAI_API_KEY:-Your-OpenAI-Api-Key}"
API_BASE="${OPENAI_API_BASE:-https://api.openai.com/v1}"
MODEL_NAME="${MAD_MODEL:-gpt-3.5-turbo}"
MAX_CONTEXT="${MAD_MAX_CONTEXT:-3900}"

python3 $MAD_PATH/code/debate4tran.py \
    -i $MAD_PATH/data/CommonMT/input.example.txt \
    -o $MAD_PATH/data/CommonMT/output \
    -lp zh-en \
    -k "$API_KEY" \
    -b "$API_BASE" \
    -m "$MODEL_NAME" \
    --max-context "$MAX_CONTEXT"
