all: build

build: schemas
	mkdir -p "./dist"
	gnome-extensions pack \
		--force \
		--extra-source=credentialsStore.js \
		--extra-source=format.js \
		--extra-source=gemSpinner.js \
		--extra-source=hyperClient.js \
		--extra-source=indicator.js \
		--extra-source=screens.js \
		--extra-source=panel-gem.png \
		--extra-source=gem \
		./hyper-credits@arnarg/ \
		--out-dir=./dist

schemas:
	glib-compile-schemas --strict ./hyper-credits@arnarg/schemas/

install: build
	gnome-extensions install \
		--force \
		"./dist/hyper-credits@arnarg.shell-extension.zip"

clean:
	rm -rf "./dist/hyper-credits@arnarg.shell-extension.zip"
	rm -rf "./hyper-credits@arnarg/schemas/gschemas.compiled"
