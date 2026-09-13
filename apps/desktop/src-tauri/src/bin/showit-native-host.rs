fn main() {
    if let Err(error) = showit_lib::native_bridge::run_native_host() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
