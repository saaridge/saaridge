class PrivacyCodexError(Exception):
    """Base error with a message safe for console output."""


class InputRejectedError(PrivacyCodexError):
    pass


class DetectorUnavailableError(PrivacyCodexError):
    pass


class DetectorExecutionError(PrivacyCodexError):
    pass


class BlockedInputError(PrivacyCodexError):
    pass


class VerificationError(PrivacyCodexError):
    pass


class TokenCollisionError(PrivacyCodexError):
    pass


class CodexPreflightError(PrivacyCodexError):
    pass


class CodexExecutionError(PrivacyCodexError):
    pass


class ArtifactSecurityError(PrivacyCodexError):
    pass


class EvaluationSafetyError(PrivacyCodexError):
    pass
