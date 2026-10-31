"""Route the `appdata` models to the Node app's database.

`appdata` holds unmanaged models for the main app's Postgres tables (users,
chats, calls, ...). They live in the `app` database alias; everything else
(face profiles, Django's own admin/auth tables) stays in `default`.

Migrations never run against `app`: the Node backend's migrations own that
schema, and Django must never create, alter or drop its tables.
"""

APP_LABEL = "appdata"
APP_DB = "app"


class AppDataRouter:
    def db_for_read(self, model, **hints):
        return APP_DB if model._meta.app_label == APP_LABEL else None

    def db_for_write(self, model, **hints):
        return APP_DB if model._meta.app_label == APP_LABEL else None

    def allow_relation(self, obj1, obj2, **hints):
        in_app = {obj1._meta.app_label == APP_LABEL, obj2._meta.app_label == APP_LABEL}
        # Relations are fine within one database, never across the two.
        return len(in_app) == 1

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        if db == APP_DB:
            return False
        if app_label == APP_LABEL:
            return False
        return None
