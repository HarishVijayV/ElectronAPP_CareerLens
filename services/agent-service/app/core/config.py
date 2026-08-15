from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://careerlens:change_me@postgres:5432/careerlens"
    redis_url: str = "redis://redis:6379/0"

    jobs_service_url: str = "http://jobs-service:8000"
    auth_service_url: str = "http://auth-service:8000"

    # one of: gemini | fireworks | anthropic | openai
    # gemini is the default because it's the only one with a genuinely permanent free
    # tier — the others give trial credits and then bill per token.
    llm_provider: str = "gemini"

    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.0-flash"

    fireworks_api_key: str = ""
    fireworks_model: str = "accounts/fireworks/models/deepseek-v4-flash-0731"
    # Used only when the model above stops existing. Hosted models get retired on the
    # vendor's schedule, not yours: `deepseek-v4-flash` (undated) vanished and every agent
    # call started failing with a 404 that Fireworks words identically to a bad API key,
    # so the error sends you hunting through credentials that were fine all along.
    #
    # gpt-oss-120b is the deliberate choice for a fallback: open-weight models keep plain
    # undated names and outlive proprietary ones, because the host isn't tied to another
    # vendor's lifecycle. Verified to support tool calling, which every agent here needs.
    fireworks_fallback_model: str = "accounts/fireworks/models/gpt-oss-120b"

    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-4-5"

    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
