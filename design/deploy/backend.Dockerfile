# zvena Design backend: the official Penpot backend image with penpot.jar rebuilt by
# bin/build-backend.sh (the fork's changed backend/common sources laid over the
# upstream jar, which ships Clojure sources rather than AOT classes).
FROM penpotapp/backend:2.18.3
COPY --chown=penpot:penpot penpot.jar /opt/penpot/backend/penpot.jar
