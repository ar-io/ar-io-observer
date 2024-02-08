{
  description = "AR.IO Observer";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = (import nixpkgs { inherit system; });
      in {
        devShells = {
          default = pkgs.mkShell {
            name = "ar-io-node-shell";
            buildInputs = with pkgs; [
              nodejs_18
              yarn
              nodePackages.typescript-language-server
            ];
          };
        };
      });

  nixConfig.bash-prompt = "\\e[32m[ar-io-observer-shell]$\\e[0m ";
}
