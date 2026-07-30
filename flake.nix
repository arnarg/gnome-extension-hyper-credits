{
  description = "GNOME extension that shows your remaining Charm Hyper credits in the GNOME top bar.";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (
        system: pkgs: {
          default =
            let
              metadata = pkgs.lib.importJSON (./. + "/hyper-credits@arnarg/metadata.json");
              version = (toString metadata.version);
            in
            pkgs.stdenv.mkDerivation {
              inherit version;

              pname = "gnome-shell-extension-hyper-credits";

              src = ./.;

              buildInputs = [
                pkgs.glib
              ];

              buildPhase = ''
                runHook preBuild
                make schemas
                runHook postBuild
              '';

              installPhase = ''
                runHook preInstall
                mkdir -p $out/share/gnome-shell/extensions
                cp -r "hyper-credits@arnarg" "$out/share/gnome-shell/extensions/"
                runHook postInstall
              '';

              passthru = {
                extensionUuid = "hyper-credits@arnarg";
                extensionPortalSlug = "hyper-credits";
              };
            };
        }
      );

      devShells = forAllSystems (
        system: pkgs: {
          default = pkgs.mkShell {
            nativeBuildInputs = with pkgs; [
              # For gnome-extension
              gnome-shell
              # For glib-compile-schemas
              glib.dev
              # Obvious
              gnumake
            ];
          };
        }
      );
    };
}
